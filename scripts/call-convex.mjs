#!/usr/bin/env node
// Signs a request exactly like the n8n workflows do, calls a Convex /n8n/*
// endpoint, and verifies the HMAC signature on the response.
//
//   N8N_TO_CONVEX_SECRET=... CONVEX_SITE_URL=http://127.0.0.1:3211 \
//     node scripts/call-convex.mjs /n8n/overdue-loans '{"action":"list_overdue"}'
//
// Flags: --bad-signature, --stale  (to see the endpoint reject them)
import { createHmac, timingSafeEqual } from "node:crypto";

const [path, body = "{}", ...flags] = process.argv.slice(2);
const secret = process.env.N8N_TO_CONVEX_SECRET;
const base = process.env.CONVEX_SITE_URL ?? "http://127.0.0.1:3211";
if (!path || !secret) {
  console.error("usage: N8N_TO_CONVEX_SECRET=... node scripts/call-convex.mjs <path> [json]");
  process.exit(2);
}

const sign = (ts, raw) => createHmac("sha256", secret).update(`${ts}.${raw}`).digest("hex");

let ts = Math.floor(Date.now() / 1000);
if (flags.includes("--stale")) ts -= 3600;
let sig = `v1=${sign(ts, body)}`;
if (flags.includes("--bad-signature")) sig = `v1=${"0".repeat(64)}`;

const res = await fetch(new URL(path, base), {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-LendLoop-Timestamp": String(ts),
    "X-LendLoop-Signature": sig,
  },
  body,
});
const text = await res.text();
const rts = res.headers.get("x-lendloop-timestamp");
const rsig = res.headers.get("x-lendloop-signature") ?? "";
let verified = false;
if (rts && rsig.startsWith("v1=")) {
  const a = Buffer.from(rsig.slice(3), "hex");
  const b = Buffer.from(sign(rts, text), "hex");
  verified = a.length === b.length && timingSafeEqual(a, b);
}
console.log(`HTTP ${res.status}  response-signature-valid=${verified}`);
console.log(text);
