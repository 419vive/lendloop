import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  internalAction,
  internalMutation,
  internalQuery,
  type MutationCtx,
} from "./_generated/server";
import { publicName } from "./lib/auth";
import { signPayload } from "./lib/hmac";

/**
 * Outbound "request notification" integration: Convex -> n8n webhook.
 *
 * Flow: a mutation that changes a loan calls `enqueueNotification`, which
 * writes an `automationEvents` row (status=pending) in the SAME transaction
 * and schedules `deliver`. Because the row and the schedule are committed
 * atomically with the business change, a notification is never lost and
 * never sent for a change that rolled back (transactional outbox).
 *
 * `deliver` signs the minimal payload with HMAC and POSTs it. Failures are
 * retried with exponential backoff; after MAX_ATTEMPTS the row is marked
 * `failed`, which the UI shows on the loan.
 */

export type NotificationEvent =
  | "request.created"
  | "request.approved"
  | "request.declined"
  | "request.auto_declined"
  | "request.cancelled"
  | "request.cancelled_listing_removed"
  | "loan.returned";

/** Who needs to hear about each event. */
const RECIPIENT: Record<NotificationEvent, "lender" | "borrower"> = {
  "request.created": "lender",
  "request.cancelled": "lender",
  "request.approved": "borrower",
  "request.declined": "borrower",
  "request.auto_declined": "borrower",
  "request.cancelled_listing_removed": "borrower",
  "loan.returned": "borrower",
};

export const MAX_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 30_000;
const REQUEST_TIMEOUT_MS = 10_000;

export async function enqueueNotification(
  ctx: MutationCtx,
  loanId: Id<"loans">,
  event: NotificationEvent,
) {
  // Each event happens at most once per loan (the status machine only moves
  // forward), so this key is a natural idempotency key end to end. n8n
  // receives it as `eventId` and can dedupe on it too.
  const idempotencyKey = `notify:${loanId}:${event}`;
  const existing = await ctx.db
    .query("automationEvents")
    .withIndex("by_key", (q) => q.eq("idempotencyKey", idempotencyKey))
    .unique();
  if (existing) return existing._id;

  const eventId = await ctx.db.insert("automationEvents", {
    loanId,
    kind: "notification",
    status: "pending",
    idempotencyKey,
    event,
    attempts: 0,
    updatedAt: Date.now(),
  });
  await ctx.scheduler.runAfter(0, internal.notifications.deliver, { eventId });
  return eventId;
}

/** Builds the data-minimised payload. Only what the notifier needs. */
export const loadForDelivery = internalQuery({
  args: { eventId: v.id("automationEvents") },
  handler: async (ctx, { eventId }) => {
    const row = await ctx.db.get("automationEvents", eventId);
    if (!row || row.kind !== "notification" || !row.event) return null;
    const loan = await ctx.db.get("loans", row.loanId);
    if (!loan) return null;
    const event = row.event as NotificationEvent;
    const role = RECIPIENT[event];
    const recipient = await ctx.db.get("users", role === "lender" ? loan.ownerId : loan.borrowerId);
    const counterpart = await ctx.db.get(
      "users",
      role === "lender" ? loan.borrowerId : loan.ownerId,
    );
    return {
      status: row.status,
      payload: {
        eventId: row.idempotencyKey,
        event,
        occurredAt: new Date(row._creationTime).toISOString(),
        loan: {
          id: loan._id,
          toolName: loan.toolName,
          startDate: loan.startDate,
          endDate: loan.endDate,
          status: loan.status,
        },
        recipient: {
          role,
          firstName: publicName(recipient),
          // Needed to actually deliver; the counterpart's email is never sent.
          email: recipient?.email ?? null,
        },
        counterpartFirstName: publicName(counterpart),
      },
    };
  },
});

export const deliver = internalAction({
  args: { eventId: v.id("automationEvents") },
  handler: async (ctx, { eventId }) => {
    const data = await ctx.runQuery(internal.notifications.loadForDelivery, { eventId });
    if (!data || data.status === "delivered") return;

    const url = process.env.N8N_WEBHOOK_URL;
    const secret = process.env.CONVEX_TO_N8N_SECRET;
    if (!url || !secret) {
      await ctx.runMutation(internal.notifications.recordAttempt, {
        eventId,
        outcome: "skipped",
        error: "N8N_WEBHOOK_URL / CONVEX_TO_N8N_SECRET not configured",
      });
      return;
    }

    const body = JSON.stringify(data.payload);
    let error: string | undefined;
    try {
      const { headers } = await signPayload(secret, body);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...headers },
          body,
          signal: controller.signal,
        });
        if (!res.ok) error = `n8n responded ${res.status}`;
      } finally {
        clearTimeout(timer);
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }

    await ctx.runMutation(internal.notifications.recordAttempt, {
      eventId,
      outcome: error ? "error" : "delivered",
      error,
    });
  },
});

export const recordAttempt = internalMutation({
  args: {
    eventId: v.id("automationEvents"),
    outcome: v.union(v.literal("delivered"), v.literal("error"), v.literal("skipped")),
    error: v.optional(v.string()),
  },
  handler: async (ctx, { eventId, outcome, error }) => {
    const row = await ctx.db.get("automationEvents", eventId);
    if (!row || row.status === "delivered") return;
    const attempts = row.attempts + 1;
    const now = Date.now();

    if (outcome === "delivered") {
      await ctx.db.patch("automationEvents", eventId, {
        status: "delivered",
        attempts,
        lastError: undefined,
        updatedAt: now,
      });
      return;
    }
    if (outcome === "skipped") {
      await ctx.db.patch("automationEvents", eventId, {
        status: "skipped",
        attempts,
        lastError: error,
        updatedAt: now,
      });
      return;
    }
    if (attempts >= MAX_ATTEMPTS) {
      console.error(`notification ${row.idempotencyKey} failed permanently: ${error}`);
      await ctx.db.patch("automationEvents", eventId, {
        status: "failed",
        attempts,
        lastError: error?.slice(0, 500),
        updatedAt: now,
      });
      return;
    }
    await ctx.db.patch("automationEvents", eventId, {
      attempts,
      lastError: error?.slice(0, 500),
      updatedAt: now,
    });
    const delay = BASE_BACKOFF_MS * 2 ** (attempts - 1); // 30s, 1m, 2m, 4m
    await ctx.scheduler.runAfter(delay, internal.notifications.deliver, { eventId });
  },
});
