/**
 * HMAC-SHA256 request signing shared by both directions of the
 * Convex <-> n8n integration.
 *
 * Wire format (mirrors Stripe/Slack style signatures):
 *   X-LendLoop-Timestamp: <unix seconds>
 *   X-LendLoop-Signature: v1=<hex(HMAC_SHA256(secret, `${timestamp}.${rawBody}`))>
 *
 * - The timestamp is part of the signed material, so it cannot be swapped
 *   without invalidating the signature; requests outside the allowed skew
 *   window are rejected to bound replay.
 * - Comparison is constant-time over the decoded bytes.
 * - Uses Web Crypto only, so it runs unchanged in the Convex runtime,
 *   Node and the test environment.
 */

export const TIMESTAMP_HEADER = "X-LendLoop-Timestamp";
export const SIGNATURE_HEADER = "X-LendLoop-Signature";
export const SIGNATURE_VERSION = "v1";
export const DEFAULT_MAX_SKEW_SECONDS = 300;

const encoder = new TextEncoder();

async function importKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function fromHex(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** Constant-time byte comparison (length leak only, which is public: 32 bytes). */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function computeSignature(
  secret: string,
  timestamp: string,
  rawBody: string,
): Promise<string> {
  const key = await importKey(secret);
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`${timestamp}.${rawBody}`),
  );
  return toHex(mac);
}

export async function signPayload(
  secret: string,
  rawBody: string,
  nowMs: number = Date.now(),
): Promise<{ timestamp: string; signature: string; headers: Record<string, string> }> {
  assertSecret(secret);
  const timestamp = Math.floor(nowMs / 1000).toString();
  const hex = await computeSignature(secret, timestamp, rawBody);
  const signature = `${SIGNATURE_VERSION}=${hex}`;
  return {
    timestamp,
    signature,
    headers: { [TIMESTAMP_HEADER]: timestamp, [SIGNATURE_HEADER]: signature },
  };
}

export type VerifyResult =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "missing_headers"
        | "bad_timestamp"
        | "timestamp_skew"
        | "bad_signature_format"
        | "signature_mismatch";
    };

export async function verifySignature(opts: {
  secret: string;
  rawBody: string;
  timestamp: string | null;
  signature: string | null;
  nowMs?: number;
  maxSkewSeconds?: number;
}): Promise<VerifyResult> {
  const { secret, rawBody, timestamp, signature } = opts;
  assertSecret(secret);
  if (!timestamp || !signature) return { ok: false, reason: "missing_headers" };

  if (!/^\d{1,12}$/.test(timestamp)) return { ok: false, reason: "bad_timestamp" };
  const nowSec = Math.floor((opts.nowMs ?? Date.now()) / 1000);
  const skew = Math.abs(nowSec - Number(timestamp));
  if (skew > (opts.maxSkewSeconds ?? DEFAULT_MAX_SKEW_SECONDS)) {
    return { ok: false, reason: "timestamp_skew" };
  }

  const prefix = `${SIGNATURE_VERSION}=`;
  if (!signature.startsWith(prefix)) return { ok: false, reason: "bad_signature_format" };
  const provided = fromHex(signature.slice(prefix.length));
  if (!provided || provided.length !== 32) {
    return { ok: false, reason: "bad_signature_format" };
  }

  const expected = fromHex(await computeSignature(secret, timestamp, rawBody))!;
  return timingSafeEqual(provided, expected)
    ? { ok: true }
    : { ok: false, reason: "signature_mismatch" };
}

function assertSecret(secret: string) {
  // Refuse to sign/verify with an empty or trivially short key: a
  // misconfigured deployment must fail closed, not accept everything.
  if (!secret || secret.length < 32) {
    throw new Error("HMAC secret is missing or shorter than 32 characters");
  }
}
