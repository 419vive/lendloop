#!/usr/bin/env node
/**
 * Generates the n8n workflow exports in n8n/workflows/*.json.
 *
 * Why a generator: the interesting logic lives in Code nodes (HMAC sign /
 * verify). Keeping it here as real JavaScript is far easier to review than
 * escaped strings inside JSON, and guarantees the three workflows share one
 * signing implementation. The generated JSON is committed and is what you
 * import into n8n (`n8n import:workflow --separate --input=/workflows`).
 *
 * Secrets are NEVER written into the JSON: Code nodes read them from the n8n
 * container's environment ($env), which docker-compose loads from n8n/.env.
 *
 *   node scripts/build-n8n-workflows.mjs
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "n8n", "workflows");

const IDS = {
  notify: "LLRequestNotify1",
  overdue: "LLOverdueRemind1",
  error: "LLErrorHandler01",
};

// ---------------------------------------------------------------------------
// Shared Code-node snippets
// ---------------------------------------------------------------------------

/** HMAC helpers injected at the top of every Code node that signs or verifies. */
const HMAC_HELPERS = `
const crypto = require('crypto');
const MAX_SKEW_SECONDS = 300;
function requireSecret(name) {
  const value = $env[name];
  if (!value || value.length < 32) throw new Error(name + ' is missing or shorter than 32 chars');
  return value;
}
// v1 = hex(HMAC_SHA256(secret, timestamp + "." + rawBody)) — same as convex/lib/hmac.ts
function sign(secret, rawBody) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const hex = crypto.createHmac('sha256', secret).update(timestamp + '.' + rawBody).digest('hex');
  return { timestamp, signature: 'v1=' + hex };
}
function verify(secret, rawBody, timestamp, signature) {
  if (!timestamp || !signature) return 'missing_headers';
  if (!/^\\d{1,12}$/.test(String(timestamp))) return 'bad_timestamp';
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > MAX_SKEW_SECONDS) return 'timestamp_skew';
  if (!String(signature).startsWith('v1=')) return 'bad_signature_format';
  const provided = Buffer.from(String(signature).slice(3), 'hex');
  const expected = crypto.createHmac('sha256', secret).update(timestamp + '.' + rawBody).digest();
  if (provided.length !== expected.length) return 'bad_signature_format';
  return crypto.timingSafeEqual(provided, expected) ? null : 'signature_mismatch';
}
`.trim();

const code = (body) => `${HMAC_HELPERS}\n\n${body.trim()}\n`;

/** Signed POST to Convex: Code node prepares {url, body, headers}; HTTP node sends it. */
function signedPostNodes({ id, name, position, path, bodyExpr, mode = "runOnceForAllItems" }) {
  const build = `
const secret = requireSecret('N8N_TO_CONVEX_SECRET');
const base = $env.CONVEX_SITE_URL;
if (!base) throw new Error('CONVEX_SITE_URL is not set');
const rawBody = JSON.stringify(${bodyExpr});
const { timestamp, signature } = sign(secret, rawBody);
const request = { url: base.replace(/\\/$/, '') + '${path}', rawBody, timestamp, signature };
`;
  const prep = {
    id: `${id}-sign`,
    name: `Sign: ${name}`,
    type: "n8n-nodes-base.code",
    typeVersion: 2,
    position,
    parameters: {
      mode,
      jsCode: code(
        mode === "runOnceForEachItem"
          ? `${build}return { json: { ...$json, request } };`
          : `${build}return [{ json: { request } }];`,
      ),
    },
  };
  const http = {
    id: `${id}-http`,
    name,
    type: "n8n-nodes-base.httpRequest",
    typeVersion: 4.2,
    position: [position[0] + 220, position[1]],
    // Transient failures (network, 5xx, timeouts) are retried; if all tries
    // fail the execution errors and the Error workflow records it.
    retryOnFail: true,
    maxTries: 3,
    waitBetweenTries: 5000,
    parameters: {
      method: "POST",
      url: "={{ $json.request.url }}",
      sendHeaders: true,
      headerParameters: {
        parameters: [
          { name: "X-LendLoop-Timestamp", value: "={{ $json.request.timestamp }}" },
          { name: "X-LendLoop-Signature", value: "={{ $json.request.signature }}" },
        ],
      },
      sendBody: true,
      contentType: "raw",
      rawContentType: "application/json",
      body: "={{ $json.request.rawBody }}",
      options: {
        timeout: 10000,
        response: { response: { fullResponse: true, responseFormat: "text" } },
      },
    },
  };
  return [prep, http];
}

/** Verifies the HMAC on a Convex response (fullResponse + text format). */
const VERIFY_CONVEX_RESPONSE = `
function verifiedConvexBody(res) {
  const secret = requireSecret('N8N_TO_CONVEX_SECRET');
  const headers = res.headers || {};
  const raw = typeof res.body === 'string' ? res.body : (res.data ?? '');
  const problem = verify(secret, raw, headers['x-lendloop-timestamp'], headers['x-lendloop-signature']);
  if (problem) throw new Error('Convex response failed signature check: ' + problem);
  return JSON.parse(raw);
}
`.trim();

const settings = (extra = {}) => ({
  executionOrder: "v1",
  saveDataErrorExecution: "all",
  saveDataSuccessExecution: "all",
  saveManualExecutions: true,
  callerPolicy: "workflowsFromSameOwner",
  ...extra,
});

// ---------------------------------------------------------------------------
// 1) Request notification: Convex -> n8n webhook
// ---------------------------------------------------------------------------

const notify = {
  id: IDS.notify,
  name: "LendLoop – Request notification",
  active: false,
  settings: settings({ errorWorkflow: IDS.error }),
  nodes: [
    {
      id: "notify-webhook",
      name: "Convex webhook",
      type: "n8n-nodes-base.webhook",
      typeVersion: 2,
      position: [0, 0],
      webhookId: "6f0d7a4e-3a52-4d55-9f31-1c1e5a0c7a11",
      parameters: {
        httpMethod: "POST",
        path: "lendloop-request-event",
        responseMode: "responseNode",
        // Raw bytes are required: the HMAC is over the exact body Convex sent.
        options: { rawBody: true },
      },
    },
    {
      id: "notify-verify",
      name: "Verify HMAC signature",
      type: "n8n-nodes-base.code",
      typeVersion: 2,
      position: [220, 0],
      parameters: {
        mode: "runOnceForAllItems",
        jsCode: code(`
const secret = requireSecret('CONVEX_TO_N8N_SECRET');
const item = $input.first();
const headers = item.json.headers || {};
const raw = (await this.helpers.getBinaryDataBuffer(0, 'data')).toString('utf8');
const problem = verify(secret, raw, headers['x-lendloop-timestamp'], headers['x-lendloop-signature']);
if (problem) {
  // Never log the body of an unauthenticated request.
  console.warn('[lendloop] rejected webhook: ' + problem);
  return [{ json: { valid: false, reason: problem } }];
}
return [{ json: { valid: true, payload: JSON.parse(raw) } }];
`),
      },
    },
    {
      id: "notify-if",
      name: "Signature valid?",
      type: "n8n-nodes-base.if",
      typeVersion: 2,
      position: [440, 0],
      parameters: {
        conditions: {
          options: { caseSensitive: true, leftValue: "", typeValidation: "strict" },
          conditions: [
            {
              id: "valid-check",
              leftValue: "={{ $json.valid }}",
              rightValue: true,
              operator: { type: "boolean", operation: "true", singleValue: true },
            },
          ],
          combinator: "and",
        },
        options: {},
      },
    },
    {
      id: "notify-build",
      name: "Build notification (dedupe by eventId)",
      type: "n8n-nodes-base.code",
      typeVersion: 2,
      position: [660, -100],
      parameters: {
        mode: "runOnceForAllItems",
        jsCode: `
// Convex retries deliveries, so the same eventId can arrive twice.
// Remember recent ids in workflow static data (persisted for active workflows).
const p = $input.first().json.payload;
const store = $getWorkflowStaticData('global');
store.seen = store.seen || [];
const duplicate = store.seen.includes(p.eventId);
if (!duplicate) store.seen = [...store.seen.slice(-499), p.eventId];

const subjects = {
  'request.created': p.counterpartFirstName + ' wants to borrow your ' + p.loan.toolName,
  'request.cancelled': p.counterpartFirstName + ' cancelled their request for your ' + p.loan.toolName,
  'request.approved': 'Your request for the ' + p.loan.toolName + ' was approved',
  'request.declined': 'Your request for the ' + p.loan.toolName + ' was declined',
  'request.auto_declined': 'The ' + p.loan.toolName + ' was booked by someone else for those dates',
  'request.cancelled_listing_removed': 'The ' + p.loan.toolName + ' is no longer listed',
  'loan.returned': p.counterpartFirstName + ' marked the ' + p.loan.toolName + ' as returned',
};
// Only the fields the notifier needs; nothing else is carried forward.
return [{ json: {
  eventId: p.eventId,
  duplicate,
  to: p.recipient.email,
  firstName: p.recipient.firstName,
  subject: subjects[p.event] || ('LendLoop update: ' + p.event),
  dates: p.loan.startDate + ' → ' + p.loan.endDate,
} }];
`.trim() + "\n",
      },
    },
    {
      id: "notify-send",
      name: "Send notification (mock: log)",
      type: "n8n-nodes-base.code",
      typeVersion: 2,
      position: [880, -100],
      parameters: {
        mode: "runOnceForAllItems",
        jsCode: `
// Mock channel: a structured log line instead of a real email/SMS.
// Swap this node for Send Email / Slack / Twilio in production.
const n = $input.first().json;
if (n.duplicate) {
  console.log('[lendloop] duplicate event ' + n.eventId + ' ignored');
} else if (!n.to) {
  console.log('[lendloop] no email on file for recipient of ' + n.eventId);
} else {
  const masked = n.to.replace(/^(.).*(@.*)$/, '$1***$2');
  console.log('[lendloop] NOTIFY to=' + masked + ' subject="' + n.subject + '" dates=' + n.dates + ' event=' + n.eventId);
}
return [{ json: { received: true, eventId: n.eventId, duplicate: n.duplicate } }];
`.trim() + "\n",
      },
    },
    {
      id: "notify-ok",
      name: "Respond 200",
      type: "n8n-nodes-base.respondToWebhook",
      typeVersion: 1.1,
      position: [1100, -100],
      parameters: { respondWith: "json", responseBody: "={{ $json }}", options: { responseCode: 200 } },
    },
    {
      id: "notify-reject",
      name: "Respond 401",
      type: "n8n-nodes-base.respondToWebhook",
      typeVersion: 1.1,
      position: [660, 120],
      parameters: {
        respondWith: "json",
        responseBody: '={{ { "error": "invalid_signature" } }}',
        options: { responseCode: 401 },
      },
    },
  ],
  connections: {
    "Convex webhook": { main: [[{ node: "Verify HMAC signature", type: "main", index: 0 }]] },
    "Verify HMAC signature": { main: [[{ node: "Signature valid?", type: "main", index: 0 }]] },
    "Signature valid?": {
      main: [
        [{ node: "Build notification (dedupe by eventId)", type: "main", index: 0 }],
        [{ node: "Respond 401", type: "main", index: 0 }],
      ],
    },
    "Build notification (dedupe by eventId)": {
      main: [[{ node: "Send notification (mock: log)", type: "main", index: 0 }]],
    },
    "Send notification (mock: log)": { main: [[{ node: "Respond 200", type: "main", index: 0 }]] },
  },
};

// ---------------------------------------------------------------------------
// 2) Overdue reminders: daily schedule -> Convex -> reminder -> write-back
// ---------------------------------------------------------------------------

const [listSign, listHttp] = signedPostNodes({
  id: "overdue-list",
  name: "Fetch overdue loans",
  position: [220, 0],
  path: "/n8n/overdue-loans",
  bodyExpr: "{ action: 'list_overdue' }",
});
const [writeSign, writeHttp] = signedPostNodes({
  id: "overdue-write",
  name: "Write reminder status to Convex",
  position: [1100, 0],
  path: "/n8n/reminder-status",
  mode: "runOnceForEachItem",
  bodyExpr:
    "{ loanId: $json.loanId, reminderKey: $json.reminderKey, status: $json.status, error: $json.error }",
});

const overdue = {
  id: IDS.overdue,
  name: "LendLoop – Overdue reminders",
  active: false,
  settings: settings({ errorWorkflow: IDS.error, timezone: "UTC" }),
  nodes: [
    {
      id: "overdue-schedule",
      name: "Every day 09:00 UTC",
      type: "n8n-nodes-base.scheduleTrigger",
      typeVersion: 1.2,
      position: [0, -100],
      parameters: { rule: { interval: [{ field: "days", daysInterval: 1, triggerAtHour: 9 }] } },
    },
    {
      id: "overdue-manual",
      name: "Run now (manual)",
      type: "n8n-nodes-base.manualTrigger",
      typeVersion: 1,
      position: [0, 100],
      parameters: {},
    },
    listSign,
    listHttp,
    {
      id: "overdue-split",
      name: "Verify response, one item per loan",
      type: "n8n-nodes-base.code",
      typeVersion: 2,
      position: [660, 0],
      parameters: {
        mode: "runOnceForAllItems",
        jsCode: code(`
${VERIFY_CONVEX_RESPONSE}

const data = verifiedConvexBody($input.first().json);
console.log('[lendloop] overdue loans for ' + data.today + ': ' + data.count);
return data.loans.map((loan) => ({ json: loan }));
`),
      },
    },
    {
      id: "overdue-send",
      name: "Send reminder (mock: log)",
      type: "n8n-nodes-base.code",
      typeVersion: 2,
      position: [880, 0],
      parameters: {
        mode: "runOnceForEachItem",
        jsCode: `
// Mock channel: log instead of emailing. A real channel would go here; its
// failure is captured per loan and written back as status=failed.
const loan = $json;
let status = 'delivered';
let error;
try {
  if (!loan.borrower.email) throw new Error('no email on file');
  const masked = loan.borrower.email.replace(/^(.).*(@.*)$/, '$1***$2');
  console.log('[lendloop] REMINDER to=' + masked + ' "Hi ' + loan.borrower.firstName + ', the ' +
    loan.toolName + ' was due back ' + loan.daysOverdue + ' day(s) ago." key=' + loan.reminderKey);
} catch (e) {
  status = 'failed';
  error = String(e.message || e).slice(0, 200);
}
// Drop the email from the item once used (data minimisation).
return { json: { loanId: loan.loanId, reminderKey: loan.reminderKey, status, error } };
`.trim() + "\n",
      },
    },
    writeSign,
    writeHttp,
    {
      id: "overdue-check",
      name: "Check write-back response",
      type: "n8n-nodes-base.code",
      typeVersion: 2,
      position: [1540, 0],
      parameters: {
        mode: "runOnceForEachItem",
        jsCode: code(`
${VERIFY_CONVEX_RESPONSE}

const result = verifiedConvexBody($json);
if (!result.ok) throw new Error('Convex rejected reminder write-back: ' + result.error);
return { json: result };
`),
      },
    },
  ],
  connections: {
    "Every day 09:00 UTC": { main: [[{ node: listSign.name, type: "main", index: 0 }]] },
    "Run now (manual)": { main: [[{ node: listSign.name, type: "main", index: 0 }]] },
    [listSign.name]: { main: [[{ node: listHttp.name, type: "main", index: 0 }]] },
    [listHttp.name]: {
      main: [[{ node: "Verify response, one item per loan", type: "main", index: 0 }]],
    },
    "Verify response, one item per loan": {
      main: [[{ node: "Send reminder (mock: log)", type: "main", index: 0 }]],
    },
    "Send reminder (mock: log)": { main: [[{ node: writeSign.name, type: "main", index: 0 }]] },
    [writeSign.name]: { main: [[{ node: writeHttp.name, type: "main", index: 0 }]] },
    [writeHttp.name]: { main: [[{ node: "Check write-back response", type: "main", index: 0 }]] },
  },
};

// ---------------------------------------------------------------------------
// 3) Error handler: any failed execution -> log + report to Convex
// ---------------------------------------------------------------------------

const [errSign, errHttp] = signedPostNodes({
  id: "error-report",
  name: "Report error to Convex",
  position: [220, 0],
  path: "/n8n/workflow-error",
  bodyExpr: `(() => {
  const e = $input.first().json;
  const report = {
    workflowName: String(e.workflow?.name || 'unknown').slice(0, 120),
    nodeName: e.execution?.lastNodeExecuted ? String(e.execution.lastNodeExecuted).slice(0, 120) : undefined,
    message: String(e.execution?.error?.message || e.trigger?.error?.message || 'Unknown error').slice(0, 1000),
    executionId: e.execution?.id ? String(e.execution.id) : undefined,
  };
  console.error('[lendloop] WORKFLOW FAILED ' + JSON.stringify(report));
  return report;
})()`,
});

const errorHandler = {
  id: IDS.error,
  name: "LendLoop – Error handler",
  active: false,
  settings: settings(),
  nodes: [
    {
      id: "error-trigger",
      name: "On workflow error",
      type: "n8n-nodes-base.errorTrigger",
      typeVersion: 1,
      position: [0, 0],
      parameters: {},
    },
    errSign,
    errHttp,
  ],
  connections: {
    "On workflow error": { main: [[{ node: errSign.name, type: "main", index: 0 }]] },
    [errSign.name]: { main: [[{ node: errHttp.name, type: "main", index: 0 }]] },
  },
};

// ---------------------------------------------------------------------------

mkdirSync(OUT, { recursive: true });
for (const [file, wf] of [
  ["request-notification.json", notify],
  ["overdue-reminders.json", overdue],
  ["error-handler.json", errorHandler],
]) {
  const json = JSON.stringify({ ...wf, pinData: {}, tags: [] }, null, 2) + "\n";
  // Guard against ever committing a secret into an export.
  if (/[0-9a-f]{64}/i.test(json)) throw new Error(`${file}: looks like it contains a secret`);
  writeFileSync(join(OUT, file), json);
  console.log(`wrote n8n/workflows/${file}`);
}
