import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { publicName } from "./lib/auth";
import { daysBetween } from "./lib/dates";

/**
 * Internal functions behind the n8n-facing HTTP endpoints in `http.ts`.
 * They are `internal*`, so they are unreachable from the public client API;
 * the only way in is through a request that passed HMAC verification.
 */

export function reminderKey(loanId: string, today: string) {
  return `overdue:${loanId}:${today}`;
}

/** Overdue = approved, not returned, end date strictly before today. */
export const overdueLoans = internalQuery({
  args: { today: v.string() },
  handler: async (ctx, { today }) => {
    const loans = await ctx.db
      .query("loans")
      .withIndex("by_status_endDate", (q) => q.eq("status", "approved").lt("endDate", today))
      .take(500);
    return await Promise.all(
      loans.map(async (loan) => {
        const borrower = await ctx.db.get("users", loan.borrowerId);
        // Data minimisation: just enough to write one reminder.
        return {
          loanId: loan._id,
          reminderKey: reminderKey(loan._id, today),
          toolName: loan.toolName,
          endDate: loan.endDate,
          daysOverdue: daysBetween(loan.endDate, today),
          borrower: { firstName: publicName(borrower), email: borrower?.email ?? null },
        };
      }),
    );
  },
});

/**
 * Idempotent write-back from the overdue workflow. Keyed by `reminderKey`
 * (one per loan per day): a retried request updates the same row instead
 * of inserting a duplicate, and a late "failed" never overwrites "delivered".
 */
export const recordReminder = internalMutation({
  args: {
    loanId: v.string(),
    reminderKey: v.string(),
    status: v.union(v.literal("delivered"), v.literal("failed")),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const loanId = ctx.db.normalizeId("loans", args.loanId);
    if (!loanId) return { ok: false as const, error: "unknown_loan" };
    const loan = await ctx.db.get("loans", loanId);
    if (!loan) return { ok: false as const, error: "unknown_loan" };
    // The key must be one we issued for this loan; stops a caller from
    // attaching arbitrary keys to arbitrary loans.
    if (!/^overdue:[^:]+:\d{4}-\d{2}-\d{2}$/.test(args.reminderKey) ||
        !args.reminderKey.startsWith(`overdue:${loanId}:`)) {
      return { ok: false as const, error: "bad_reminder_key" };
    }

    const now = Date.now();
    const existing = await ctx.db
      .query("automationEvents")
      .withIndex("by_key", (q) => q.eq("idempotencyKey", args.reminderKey))
      .unique();
    if (existing) {
      if (existing.status !== "delivered") {
        await ctx.db.patch("automationEvents", existing._id, {
          status: args.status,
          attempts: existing.attempts + 1,
          lastError: args.error?.slice(0, 500),
          updatedAt: now,
        });
      }
      return { ok: true as const, duplicate: true, eventId: existing._id };
    }
    const eventId = await ctx.db.insert("automationEvents", {
      loanId,
      kind: "overdue_reminder",
      status: args.status,
      idempotencyKey: args.reminderKey,
      attempts: 1,
      lastError: args.error?.slice(0, 500),
      updatedAt: now,
    });
    return { ok: true as const, duplicate: false, eventId };
  },
});

/** Called by the n8n error workflow. Deduped by workflow execution id. */
export const recordWorkflowError = internalMutation({
  args: {
    workflowName: v.string(),
    nodeName: v.optional(v.string()),
    message: v.string(),
    executionId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const errorKey = `${args.workflowName}:${args.executionId ?? Date.now()}`;
    const existing = await ctx.db
      .query("workflowErrors")
      .withIndex("by_key", (q) => q.eq("errorKey", errorKey))
      .unique();
    if (existing) return { ok: true, duplicate: true };
    await ctx.db.insert("workflowErrors", {
      errorKey,
      workflowName: args.workflowName.slice(0, 120),
      nodeName: args.nodeName?.slice(0, 120),
      message: args.message.slice(0, 1000),
      executionId: args.executionId?.slice(0, 64),
      occurredAt: Date.now(),
    });
    return { ok: true, duplicate: false };
  },
});
