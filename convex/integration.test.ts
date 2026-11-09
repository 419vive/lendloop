/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { addDays, toIsoDate } from "./lib/dates";
import { signPayload, verifySignature } from "./lib/hmac";
import { MAX_ATTEMPTS } from "./notifications";

const modules = import.meta.glob("./**/*.ts");
const N8N_TO_CONVEX = "n".repeat(64);
const CONVEX_TO_N8N = "c".repeat(64);

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("N8N_TO_CONVEX_SECRET", N8N_TO_CONVEX);
  vi.stubEnv("CONVEX_TO_N8N_SECRET", CONVEX_TO_N8N);
  vi.stubEnv("N8N_WEBHOOK_URL", "https://n8n.test/webhook/lendloop-request-event");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function seedOverdue() {
  const t = convexTest(schema, modules);
  const { overdueLoan } = (await t.mutation(internal.seed.demo, {})) as { overdueLoan: string };
  return { t, loanId: overdueLoan };
}

async function signedPost(
  t: ReturnType<typeof convexTest>,
  path: string,
  body: unknown,
  opts: { secret?: string; nowMs?: number } = {},
) {
  const raw = JSON.stringify(body);
  const { headers } = await signPayload(opts.secret ?? N8N_TO_CONVEX, raw, opts.nowMs);
  return t.fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: raw,
  });
}

describe("n8n -> Convex HTTP endpoints", () => {
  it("lists overdue loans with minimal fields and a signed response", async () => {
    const { t, loanId } = await seedOverdue();
    const res = await signedPost(t, "/n8n/overdue-loans", { action: "list_overdue" });
    expect(res.status).toBe(200);
    const text = await res.text();
    const check = await verifySignature({
      secret: N8N_TO_CONVEX,
      rawBody: text,
      timestamp: res.headers.get("X-LendLoop-Timestamp"),
      signature: res.headers.get("X-LendLoop-Signature"),
    });
    expect(check.ok).toBe(true);
    const data = JSON.parse(text);
    expect(data.loans).toHaveLength(1);
    expect(data.loans[0]).toMatchObject({ loanId, daysOverdue: 2, borrower: { firstName: "Bob" } });
    // No lender data, no tokens, no internal ids beyond the loan.
    expect(Object.keys(data.loans[0]).sort()).toEqual(
      ["borrower", "daysOverdue", "endDate", "loanId", "reminderKey", "toolName"].sort(),
    );
    expect(text).not.toContain("alice@example.com");
  });

  it("rejects unsigned, wrongly signed and stale requests", async () => {
    const { t } = await seedOverdue();
    const unsigned = await t.fetch("/n8n/overdue-loans", {
      method: "POST",
      body: JSON.stringify({ action: "list_overdue" }),
    });
    expect(unsigned.status).toBe(401);
    const wrong = await signedPost(t, "/n8n/overdue-loans", { action: "list_overdue" }, { secret: "x".repeat(64) });
    expect(wrong.status).toBe(401);
    const stale = await signedPost(t, "/n8n/overdue-loans", { action: "list_overdue" }, { nowMs: Date.now() - 600_000 });
    expect(stale.status).toBe(401);
  });

  it("fails closed when the deployment has no secret configured", async () => {
    const { t } = await seedOverdue();
    vi.stubEnv("N8N_TO_CONVEX_SECRET", "");
    const res = await t.fetch("/n8n/overdue-loans", { method: "POST", body: "{}" });
    expect(res.status).toBe(503);
  });

  it("reminder write-back is idempotent across retries", async () => {
    const { t, loanId } = await seedOverdue();
    const reminderKey = `overdue:${loanId}:${toIsoDate(Date.now())}`;
    const body = { loanId, reminderKey, status: "delivered" };
    const first = await (await signedPost(t, "/n8n/reminder-status", body)).json();
    const retry = await (await signedPost(t, "/n8n/reminder-status", body)).json();
    expect(first).toMatchObject({ ok: true, duplicate: false });
    expect(retry).toMatchObject({ ok: true, duplicate: true, eventId: first.eventId });
    // A late "failed" from an earlier attempt must not downgrade "delivered".
    await signedPost(t, "/n8n/reminder-status", { ...body, status: "failed", error: "timeout" });

    const rows = await t.run((ctx) => ctx.db.query("automationEvents").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "overdue_reminder", status: "delivered" });
  });

  it("rejects reminder keys that were not issued for that loan", async () => {
    const { t, loanId } = await seedOverdue();
    const res = await signedPost(t, "/n8n/reminder-status", {
      loanId,
      reminderKey: "overdue:someOtherLoan:2026-01-01",
      status: "delivered",
    });
    expect(res.status).toBe(422);
  });

  it("records workflow errors once per execution", async () => {
    const { t } = await seedOverdue();
    const body = { workflowName: "Overdue reminders", message: "boom", executionId: "7" };
    await signedPost(t, "/n8n/workflow-error", body);
    await signedPost(t, "/n8n/workflow-error", body);
    const rows = await t.run((ctx) => ctx.db.query("workflowErrors").collect());
    expect(rows).toHaveLength(1);
  });
});

describe("Convex -> n8n request notifications", () => {
  async function requestLoan() {
    const t = convexTest(schema, modules);
    const alice = t.withIdentity({ tokenIdentifier: "t|alice", name: "Alice Smith", email: "alice@example.com" });
    const bob = t.withIdentity({ tokenIdentifier: "t|bob", name: "Bob Jones", email: "bob@example.com" });
    await alice.mutation(api.users.store, {});
    await bob.mutation(api.users.store, {});
    const toolId = await alice.mutation(api.tools.create, {
      name: "Ladder",
      category: "hand_tools",
      condition: "good",
      description: "",
    });
    const today = toIsoDate(Date.now());
    await bob.mutation(api.loans.request, { toolId, startDate: today, endDate: addDays(today, 1) });
    return { t };
  }

  it("sends a signed, data-minimised payload to the lender", async () => {
    const calls: { headers: Headers; body: string }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      calls.push({ headers: new Headers(init.headers), body: init.body as string });
      return new Response("ok", { status: 200 });
    }));
    const { t } = await requestLoan();
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(calls).toHaveLength(1);
    const { headers, body } = calls[0];
    const check = await verifySignature({
      secret: CONVEX_TO_N8N,
      rawBody: body,
      timestamp: headers.get("X-LendLoop-Timestamp"),
      signature: headers.get("X-LendLoop-Signature"),
    });
    expect(check.ok).toBe(true);
    const payload = JSON.parse(body);
    expect(payload.event).toBe("request.created");
    expect(payload.recipient).toEqual({ role: "lender", firstName: "Alice", email: "alice@example.com" });
    expect(payload.counterpartFirstName).toBe("Bob");
    expect(body).not.toContain("bob@example.com"); // the counterpart's email never leaves Convex

    const [row] = await t.run((ctx) => ctx.db.query("automationEvents").collect());
    expect(row).toMatchObject({ status: "delivered", attempts: 1 });
  });

  it("retries with backoff and marks the delivery failed after MAX_ATTEMPTS", async () => {
    const fetchMock = vi.fn(async () => new Response("down", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    const { t } = await requestLoan();
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(fetchMock).toHaveBeenCalledTimes(MAX_ATTEMPTS);
    const [row] = await t.run((ctx) => ctx.db.query("automationEvents").collect());
    expect(row).toMatchObject({ status: "failed", attempts: MAX_ATTEMPTS, lastError: "n8n responded 503" });
  });

  it("marks the event skipped (not silently dropped) when n8n is not configured", async () => {
    vi.stubEnv("N8N_WEBHOOK_URL", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { t } = await requestLoan();
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(fetchMock).not.toHaveBeenCalled();
    const [row] = await t.run((ctx) => ctx.db.query("automationEvents").collect());
    expect(row.status).toBe("skipped");
  });
});
