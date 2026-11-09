import { httpRouter } from "convex/server";
import { internal } from "./_generated/api";
import { httpAction, type ActionCtx } from "./_generated/server";
import { toIsoDate } from "./lib/dates";
import { SIGNATURE_HEADER, signPayload, TIMESTAMP_HEADER, verifySignature } from "./lib/hmac";

/**
 * n8n -> Convex endpoints. Every request must carry a valid HMAC signature
 * made with N8N_TO_CONVEX_SECRET (see lib/hmac.ts); every response is signed
 * with the same secret so n8n can verify it came from this deployment.
 *
 * Routes live under /n8n/ and all use POST with a JSON body, so the signed
 * bytes always include the intent of the call (no "empty body" signatures
 * that could be replayed against a different route).
 */

const MAX_BODY_BYTES = 64 * 1024;

type Json = Record<string, unknown>;

async function signedJson(status: number, data: unknown): Promise<Response> {
  const body = JSON.stringify(data);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const secret = process.env.N8N_TO_CONVEX_SECRET;
  if (secret) Object.assign(headers, (await signPayload(secret, body)).headers);
  return new Response(body, { status, headers });
}

/** Verifies size + signature and parses the body; returns a Response on failure. */
async function readVerified(request: Request): Promise<Json | Response> {
  const secret = process.env.N8N_TO_CONVEX_SECRET;
  if (!secret) {
    // Fail closed: an unconfigured deployment must not accept anything.
    return new Response(JSON.stringify({ error: "not_configured" }), { status: 503 });
  }
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) return signedJson(413, { error: "payload_too_large" });

  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return signedJson(413, { error: "payload_too_large" });

  const result = await verifySignature({
    secret,
    rawBody: raw,
    timestamp: request.headers.get(TIMESTAMP_HEADER),
    signature: request.headers.get(SIGNATURE_HEADER),
  });
  if (!result.ok) {
    // Log the precise reason for operators; return a generic error to callers.
    console.warn(`rejected n8n request to ${new URL(request.url).pathname}: ${result.reason}`);
    return signedJson(401, { error: "invalid_signature" });
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return signedJson(400, { error: "invalid_json" });
    }
    return parsed as Json;
  } catch {
    return signedJson(400, { error: "invalid_json" });
  }
}

const str = (v: unknown, max = 500): string | undefined =>
  typeof v === "string" && v.length > 0 && v.length <= max ? v : undefined;

function handler(fn: (ctx: ActionCtx, body: Json) => Promise<Response>) {
  return httpAction(async (ctx, request) => {
    const body = await readVerified(request);
    if (body instanceof Response) return body;
    try {
      return await fn(ctx, body);
    } catch (e) {
      console.error("n8n endpoint failed", e);
      // 5xx tells n8n's retry logic to try again.
      return signedJson(500, { error: "internal_error" });
    }
  });
}

const http = httpRouter();

http.route({
  path: "/n8n/overdue-loans",
  method: "POST",
  handler: handler(async (ctx, body) => {
    if (body.action !== "list_overdue") return signedJson(400, { error: "unknown_action" });
    const today = toIsoDate(Date.now());
    const loans = await ctx.runQuery(internal.automation.overdueLoans, { today });
    return signedJson(200, { today, count: loans.length, loans });
  }),
});

http.route({
  path: "/n8n/reminder-status",
  method: "POST",
  handler: handler(async (ctx, body) => {
    const loanId = str(body.loanId, 64);
    const reminderKey = str(body.reminderKey, 128);
    const status = body.status === "delivered" || body.status === "failed" ? body.status : undefined;
    if (!loanId || !reminderKey || !status) return signedJson(400, { error: "invalid_body" });
    const result = await ctx.runMutation(internal.automation.recordReminder, {
      loanId,
      reminderKey,
      status,
      error: str(body.error),
    });
    return signedJson(result.ok ? 200 : 422, result);
  }),
});

http.route({
  path: "/n8n/workflow-error",
  method: "POST",
  handler: handler(async (ctx, body) => {
    const workflowName = str(body.workflowName, 120);
    const message = str(body.message, 1000);
    if (!workflowName || !message) return signedJson(400, { error: "invalid_body" });
    const result = await ctx.runMutation(internal.automation.recordWorkflowError, {
      workflowName,
      message,
      nodeName: str(body.nodeName, 120),
      executionId: str(body.executionId, 64),
    });
    return signedJson(200, result);
  }),
});

export default http;
