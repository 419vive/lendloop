# LendLoop

**Borrow what you need. Lend what you don't.**
A neighbourhood tool-lending library: list the drill in your garage, borrow the
tent you need once a year.

Built with **Next.js 16 (App Router) · Clerk · Convex · n8n (self-hosted) · TypeScript**.

| | |
|---|---|
| Public page | Read-only catalogue (name + category only) and a *Sign in to lend or borrow* button |
| Signed-in | List / edit / delete your tools · request a tool for a date range · approve / decline / mark returned · views for **All tools** (availability + category filter), **My listings**, **My requests**, **Incoming requests** |
| Admin | Remove any listing · see all loans · mark a lender **Trusted Lender** · automation health (failed deliveries, n8n errors) |
| Automation | n8n **request notifications** (webhook) and **daily overdue reminders** with signed, idempotent write-backs, plus an **error workflow** |
| Bonus | Per-loan automation activity in the UI (“⚙ Reminder sent 2 days ago”) and data minimisation throughout |

---

## Architecture

```
                ┌──────────────────────────── Browser ────────────────────────────┐
                │ Next.js (client components)  ── Clerk session ──┐               │
                └──────────────┬───────────────────────────────────┼───────────────┘
                               │ Convex queries/mutations          │ JWT (aud=convex)
                               ▼                                   ▼
┌──────────────────────────────────── Convex ─────────────────────────────────────────┐
│ users · tools · loans · automationEvents · workflowErrors                           │
│                                                                                     │
│ loans.ts mutation ──(same txn)──► automationEvents(pending) + scheduler.runAfter    │
│                                         │                                           │
│ notifications.deliver (action) ── HMAC-signed POST ──────────────────┐              │
│   retries 30s·1m·2m·4m, then status=failed                           │              │
│                                                                       ▼              │
│ http.ts  /n8n/overdue-loans      ◄── HMAC-signed POST ──┐   ┌───────────────────┐   │
│          /n8n/reminder-status    ◄──────────────────────┤   │       n8n         │   │
│          /n8n/workflow-error     ◄──────────────────────┤   │ 1 Request notify  │   │
│   (responses are HMAC-signed too)                       └───┤ 2 Overdue (daily) │   │
│                                                             │ 3 Error handler   │   │
└─────────────────────────────────────────────────────────────┴───────────────────┴───┘
```

**Why this shape**

- **Convex owns all business rules and authorization.** Every public query/mutation resolves
  the caller from the verified Clerk JWT and checks ownership/role itself
  ([`convex/lib/auth.ts`](convex/lib/auth.ts)). The UI hides buttons for UX only; `proxy.ts`
  runs `clerkMiddleware()` but does **no** path-based authorization (Clerk 7 deprecates that
  pattern, and it would be the wrong layer anyway).
- **One `loans` table, one state machine.** A borrow request *is* the loan:
  `pending → approved → returned`, or `pending → declined | cancelled`. Transitions are
  forward-only and each is guarded by actor + current status ([`convex/loans.ts`](convex/loans.ts)).
- **Transactional outbox for notifications.** The mutation that changes a loan inserts an
  `automationEvents` row and schedules delivery *in the same transaction*, so a notification is
  never lost and never sent for a change that rolled back. Delivery happens in an action with
  exponential backoff; the row ends `delivered`, `failed` or `skipped` (n8n not configured), and
  that status is visible on the loan.
- **n8n is a worker, not a database.** It never touches Convex tables directly; it talks to three
  narrow HTTP endpoints backed by `internal*` functions that are unreachable from the browser.

### Repository map

```
convex/
  schema.ts            data model + indexes
  lib/auth.ts          requireUser / requireAdmin / ADMIN_EMAILS / first-name-only helper
  lib/hmac.ts          sign + verify (Web Crypto, constant-time compare, skew window)
  tools.ts loans.ts    public API with RBAC
  admin.ts users.ts    admin features, user upsert from Clerk identity
  notifications.ts     outbox + signed webhook delivery + retries
  automation.ts        internal functions behind the n8n endpoints (idempotent writes)
  http.ts              /n8n/* routes: size limit → HMAC verify → validate → run → sign response
  seed.ts              `npx convex run seed:demo` demo data (internal)
  *.test.ts            vitest + convex-test
src/
  app/                 / (public) and (app)/{browse,listings,requests,incoming,admin}
  components/          views, forms, badges, providers
  proxy.ts             clerkMiddleware()
n8n/
  docker-compose.yml   self-hosted n8n 2.46.7, bound to 127.0.0.1
  workflows/*.json     exported workflows (no secrets)
scripts/
  build-n8n-workflows.mjs   generates n8n/workflows/*.json (single source for Code-node logic)
  call-convex.mjs           sign + call a /n8n/* endpoint by hand, verify the response signature
```

---

## Local setup

Prerequisites: Node 20.9+ (tested on 22), Docker, a free [Clerk](https://clerk.com) account.
A Convex account is optional for local development (see step 2).

### 1. Install

```bash
npm install
cp .env.example .env.local
```

### 2. Convex

```bash
npx convex dev
```

This creates a deployment (log in for a cloud dev deployment, or run with
`CONVEX_AGENT_MODE=anonymous` for a local, account-less one), writes `CONVEX_DEPLOYMENT`,
`NEXT_PUBLIC_CONVEX_URL` and `NEXT_PUBLIC_CONVEX_SITE_URL` into `.env.local`, and keeps
pushing functions while it runs. The first push fails until `CLERK_JWT_ISSUER_DOMAIN` is set (next step).

### 3. Clerk

1. Create a Clerk application. Copy **Publishable key** and **Secret key** into `.env.local`.
2. Clerk Dashboard → **Integrations → Convex** → activate. Copy the **Frontend API URL**.
3. Set the Convex deployment env (see [`convex/.env.example`](convex/.env.example) for all of them):

```bash
npx convex env set CLERK_JWT_ISSUER_DOMAIN https://<your-app>.clerk.accounts.dev
npx convex env set ADMIN_EMAILS you@example.com
```

4. Clerk's session token does not carry the user's name or email by default, and LendLoop
   needs both (display name, admin check). Clerk Dashboard → **Sessions → Customize session
   token**, set the claims to:

   ```json
   {
     "aud": "convex",
     "name": "{{user.full_name}}",
     "email": "{{user.primary_email_address}}"
   }
   ```

`ADMIN_EMAILS` is matched against that email on every sign-in (Clerk only issues tokens for
verified primary addresses). Changes to the token apply within about a minute; reload the app.

### 4. Secrets for the n8n integration

```bash
openssl rand -hex 32   # → CONVEX_TO_N8N_SECRET
openssl rand -hex 32   # → N8N_TO_CONVEX_SECRET
npx convex env set CONVEX_TO_N8N_SECRET <first>
npx convex env set N8N_TO_CONVEX_SECRET <second>
npx convex env set N8N_WEBHOOK_URL http://localhost:5678/webhook/lendloop-request-event
```

### 5. n8n

```bash
cd n8n
cp .env.example .env          # paste the same two secrets, plus N8N_ENCRYPTION_KEY
docker compose up -d
docker compose exec n8n n8n import:workflow --separate --input=/workflows
for id in LLErrorHandler01 LLRequestNotify1 LLOverdueRemind1; do
  docker compose exec n8n n8n publish:workflow --id=$id
done
docker compose restart n8n
```

Open <http://localhost:5678> to create the owner account and inspect executions.
`CONVEX_SITE_URL` in `n8n/.env` must point at the Convex **HTTP actions** URL as seen from
inside Docker: `http://host.docker.internal:3211` for a local deployment, or
`https://<deployment>.convex.site` for a cloud one.

### 6. Run

```bash
npm run dev            # http://localhost:3000
npx convex run seed:demo   # optional: demo users, tools and one overdue loan
```

### Trying the automation

- **Request notification:** request a tool, then `docker compose -f n8n/docker-compose.yml logs n8n | grep lendloop`
  shows `NOTIFY to=a***@example.com subject="Bob wants to borrow your Hedge trimmer" …`; the loan shows
  “⚙ Lender notified just now”.
- **Overdue reminders:** runs daily at 09:00 UTC. To run it now, open the workflow and click
  **Execute workflow** (manual trigger), or
  `docker compose exec -e N8N_RUNNERS_BROKER_PORT=5690 n8n n8n execute --id=LLOverdueRemind1`.
  The overdue loan shows “⚙ Reminder sent just now”. Running it again the same day changes nothing
  (`duplicate: true`).
- **Error workflow:** any failed production execution is logged and reported to
  `/n8n/workflow-error`; admins see it under **Admin → Automation health**.
- **Endpoints by hand:**
  ```bash
  N8N_TO_CONVEX_SECRET=… CONVEX_SITE_URL=http://127.0.0.1:3211 \
    node scripts/call-convex.mjs /n8n/overdue-loans '{"action":"list_overdue"}'
  # add --bad-signature or --stale to watch it get rejected (401)
  ```

### Checks

```bash
npm test            # vitest: HMAC, RBAC (convex-test), HTTP endpoints, webhook retries
npm run typecheck   # app + convex
npm run lint
npm run build
npm run n8n:build   # regenerate n8n/workflows/*.json after editing the generator
```

---

## Environment variables

| Where | Name | Purpose |
|---|---|---|
| `.env.local` | `NEXT_PUBLIC_CONVEX_URL`, `CONVEX_DEPLOYMENT` | Written by `npx convex dev` |
| `.env.local` | `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY` | Clerk app keys |
| Convex env | `CLERK_JWT_ISSUER_DOMAIN` | Clerk Frontend API URL; Convex verifies JWTs against it |
| Convex env | `ADMIN_EMAILS` | Comma-separated admin emails |
| Convex env | `N8N_WEBHOOK_URL` | Request-notification webhook. Unset → events are marked `skipped`, never silently dropped |
| Convex env + `n8n/.env` | `CONVEX_TO_N8N_SECRET` | Convex signs webhook calls; n8n verifies |
| Convex env + `n8n/.env` | `N8N_TO_CONVEX_SECRET` | n8n signs endpoint calls; Convex verifies and signs its responses |
| `n8n/.env` | `CONVEX_SITE_URL` | Base URL for the `/n8n/*` endpoints |
| `n8n/.env` | `N8N_ENCRYPTION_KEY` | n8n's own credential encryption |

No secret lives in source code or in the workflow exports. The generator refuses to write a
workflow file that contains anything that looks like a 256-bit hex key.

---

## Security decisions

**Authorization (RBAC) in Convex, not the UI.**
- *user*: create listings; edit/delete only their own; request tools that aren't theirs; cancel their
  own pending requests; approve/decline/mark-returned only for requests on their own tools.
- *admin*: everything above, plus remove any listing, list all loans (with contact emails), and toggle
  Trusted Lender. Admins **cannot** edit other people's listings; moderation is removal, not rewriting.
- The role is derived server-side on each sign-in from `ADMIN_EMAILS` and the **verified** email
  claim. A client cannot send a role, and an unverified email is never promoted (tested).
- Server-side validation of every input (lengths, real calendar dates, no past dates, ≤30-day loans,
  ≤180 days ahead, no double booking, one open request per borrower per tool).

**HMAC in both directions** ([`convex/lib/hmac.ts`](convex/lib/hmac.ts), mirrored in the n8n Code nodes).
- `X-LendLoop-Signature: v1=hex(HMAC-SHA256(secret, timestamp + "." + rawBody))` plus
  `X-LendLoop-Timestamp`. The timestamp is inside the MAC, so it can't be swapped.
- Requests more than **300 s** from the receiver's clock are rejected, which bounds replay. Write-backs are
  idempotent, so a replay inside the window can't create duplicates.
- Comparison is **constant-time** over the decoded bytes (`timingSafeEqual`).
- n8n verifies over the **raw body bytes** (Webhook node *Raw Body* option), not re-serialised JSON.
- **Separate secret per direction**, so a leaked n8n-side secret can't forge Convex→n8n events, and
  vice versa.
- **Responses are signed too.** n8n checks that the overdue list really came from Convex before
  emailing anyone.
- **Fail closed:** missing or short (<32 chars) secret → Convex returns `503` and signs nothing; n8n
  throws (and the error workflow fires).
- All `/n8n/*` routes are `POST` with a JSON body that names the action, so a signature always
  covers the intent. Bodies over 64 KB are refused before verification. Callers get a generic
  `invalid_signature`; the precise reason goes only to the server log.

**Least privilege.** The HTTP endpoints call `internal*` functions that are not part of the public
API. n8n can list overdue loans, record a reminder for a key Convex issued (checked against the
loan), and log an error. Nothing else.

**Other:** n8n is bound to `127.0.0.1`; Clerk session handling is untouched; the app never
renders user content as HTML.

## Data minimisation

- **Public catalogue:** name + category only, enforced by the query's return shape (tested).
- **Signed-in users** see other members by **first name only**; emails are never returned to peers.
  The caller's own email is returned only by `users.me`. Admins see emails because they need to
  contact people.
- **Webhook payload** (`request.*` events): event id, event type, tool name, dates, status, the
  recipient's first name **and email** (needed to deliver), and the counterpart's first name. The
  counterpart's email never leaves Convex (tested).
- **Overdue payload:** loan id, reminder key, tool name, end date, days overdue, borrower first name
  + email. No lender data.
- **In n8n:** the reminder node drops the email from the item after use; logs mask addresses
  (`b***@example.com`); execution data is pruned after 7 days (`EXECUTIONS_DATA_MAX_AGE`).
- Loans keep a `toolName` snapshot so history and notifications survive listing deletion without
  keeping the listing itself.

## Reliability & error handling

| Failure | What happens |
|---|---|
| n8n down / 5xx / timeout (Convex → n8n) | Retried at 30 s, 1 m, 2 m, 4 m (5 attempts), then `failed`. Shown on the loan and in Admin → Automation health |
| Convex down / 5xx (n8n → Convex) | HTTP Request nodes retry 3× (5 s apart), then the execution fails → **Error handler** workflow logs it and reports it to Convex |
| Duplicate webhook delivery | n8n dedupes by `eventId` (workflow static data); the Convex event key is unique per loan + event |
| Retried reminder write-back | Upsert by `reminderKey = overdue:<loanId>:<date>`; a late `failed` never overwrites `delivered` |
| Error report retried | Deduped by `workflowName:executionId` |
| n8n not configured | Events are marked `skipped` (visible), not lost silently |
| Bad input from a user | `ConvexError` with a readable message, shown inline next to the action |

## Testing

`npm test` runs 30 tests in ~1 s:

- `convex/hmac.test.ts`: round trip; cross-check against `node:crypto` (what n8n uses); tampered body;
  wrong secret; swapped timestamp; skew window; malformed headers; short or missing secret fails closed.
- `convex/rbac.test.ts` (convex-test): admin promotion only for verified `ADMIN_EMAILS`; owner-only
  edits; admin removal; full request → approve → return flow with the wrong actor rejected at each
  step; date validation; overlap auto-decline; per-user visibility; Trusted Lender admin-only.
- `convex/integration.test.ts`: signed endpoint calls via `t.fetch`, response signature check, 401
  for unsigned, wrongly signed and stale requests, 503 when unconfigured, idempotent write-back,
  forged reminder key rejected, webhook payload signature and minimisation, retry-then-`failed`
  after 5 attempts, `skipped` when unconfigured.

The n8n workflows were run against the real n8n 2.46.7 container: forged webhook → 401; real Convex
event → verified and logged; overdue run end to end including signed write-back and the duplicate
on re-run; a failing execution → error workflow → row in `workflowErrors`.

---

## What I'd change for production

- **Real delivery channel** (Postmark/SES/Slack) instead of log lines, with per-user notification
  preferences and unsubscribe.
- **Secrets:** move from `$env` in Code nodes to n8n external secrets (Vault/AWS Secrets Manager), and
  set `N8N_BLOCK_ENV_ACCESS_IN_NODE=true` so workflows can't read unrelated env vars. Rotate the HMAC
  keys with dual-key verification (`v1=` current, also accept previous) during rollover.
- **Replay protection beyond the skew window:** store seen `(timestamp, signature)` nonces for 5 min in
  Convex for non-idempotent routes.
- **n8n hardening:** Postgres instead of SQLite, queue mode with workers, HTTPS behind a reverse proxy,
  basic-auth/IP allow-listing on the webhook path, and alerting from the error workflow (PagerDuty or
  Slack), not just a Convex row.
- **Scale:** paginate the catalogue and loan lists (`.paginate()`), keep availability in a denormalised
  field instead of computing it per tool, and batch the overdue list if it grows past 500.
- **Product:** a calendar picker that blocks booked dates, borrower-initiated "I returned it" that the
  lender confirms, audit log for admin actions, and soft-delete for listings.
- **Ops:** CI (typecheck, lint, test, build, workflow-JSON secret scan), preview deployments per PR,
  Sentry for the frontend and Convex log streaming.

## AI usage

This project was built with an AI coding assistant (allowed by the brief). Design constraints were
set up front, and every behaviour described above was verified locally: unit/integration tests,
deliberately breaking checks to make sure the tests fail, and running the workflows in a real n8n
instance.
