import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  computeSignature,
  signPayload,
  timingSafeEqual,
  verifySignature,
} from "./lib/hmac";

const SECRET = "a".repeat(64);
const BODY = JSON.stringify({ action: "list_overdue" });
const NOW = 1_800_000_000_000;

async function signed(body = BODY, nowMs = NOW) {
  const { timestamp, signature } = await signPayload(SECRET, body, nowMs);
  return { timestamp, signature };
}

describe("HMAC signing", () => {
  it("round-trips a valid signature", async () => {
    const { timestamp, signature } = await signed();
    expect(signature).toMatch(/^v1=[0-9a-f]{64}$/);
    await expect(
      verifySignature({ secret: SECRET, rawBody: BODY, timestamp, signature, nowMs: NOW }),
    ).resolves.toEqual({ ok: true });
  });

  it("matches node:crypto, which the n8n Code nodes use", async () => {
    const expected = createHmac("sha256", SECRET).update(`1800000000.${BODY}`).digest("hex");
    await expect(computeSignature(SECRET, "1800000000", BODY)).resolves.toBe(expected);
  });

  it("rejects a tampered body", async () => {
    const { timestamp, signature } = await signed();
    const res = await verifySignature({
      secret: SECRET,
      rawBody: BODY.replace("list", "drop"),
      timestamp,
      signature,
      nowMs: NOW,
    });
    expect(res).toEqual({ ok: false, reason: "signature_mismatch" });
  });

  it("rejects a signature made with another secret", async () => {
    const { timestamp, signature } = await signPayload("b".repeat(64), BODY, NOW);
    const res = await verifySignature({ secret: SECRET, rawBody: BODY, timestamp, signature, nowMs: NOW });
    expect(res.ok).toBe(false);
  });

  it("rejects a swapped timestamp (the timestamp is part of the signed bytes)", async () => {
    const { signature } = await signed();
    const res = await verifySignature({
      secret: SECRET,
      rawBody: BODY,
      timestamp: String(NOW / 1000 + 10),
      signature,
      nowMs: NOW,
    });
    expect(res).toEqual({ ok: false, reason: "signature_mismatch" });
  });

  it("rejects requests outside the clock-skew window (bounds replay)", async () => {
    const old = await signed(BODY, NOW - 301_000);
    expect(
      await verifySignature({ secret: SECRET, rawBody: BODY, ...old, nowMs: NOW }),
    ).toEqual({ ok: false, reason: "timestamp_skew" });
    // Small skew in either direction is tolerated.
    const future = await signed(BODY, NOW + 60_000);
    expect(
      await verifySignature({ secret: SECRET, rawBody: BODY, ...future, nowMs: NOW }),
    ).toEqual({ ok: true });
  });

  it("rejects missing and malformed headers", async () => {
    const base = { secret: SECRET, rawBody: BODY, nowMs: NOW };
    const { timestamp, signature } = await signed();
    expect(await verifySignature({ ...base, timestamp: null, signature })).toEqual({
      ok: false,
      reason: "missing_headers",
    });
    expect(await verifySignature({ ...base, timestamp: "abc", signature })).toEqual({
      ok: false,
      reason: "bad_timestamp",
    });
    expect(await verifySignature({ ...base, timestamp, signature: signature.slice(3) })).toEqual({
      ok: false,
      reason: "bad_signature_format",
    });
    expect(await verifySignature({ ...base, timestamp, signature: "v1=zz" })).toEqual({
      ok: false,
      reason: "bad_signature_format",
    });
  });

  it("fails closed with a missing or short secret", async () => {
    await expect(signPayload("", BODY)).rejects.toThrow(/secret/);
    await expect(
      verifySignature({ secret: "short", rawBody: BODY, timestamp: "1", signature: "v1=00" }),
    ).rejects.toThrow(/secret/);
  });

  it("timingSafeEqual compares bytes exactly", () => {
    expect(timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
    expect(timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false);
    expect(timingSafeEqual(new Uint8Array([1]), new Uint8Array([1, 2]))).toBe(false);
  });
});
