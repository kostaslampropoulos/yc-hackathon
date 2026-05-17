import crypto from "crypto";

export function verifyHmac(
  rawBody: string,
  signature: string, // value of X-Webhook-Signature header, format "sha256=<hex>"
  timestamp: string, // value of X-Webhook-Timestamp header, unix seconds
  secret: string,
): boolean {
  if (!signature || !timestamp || !secret) return false;

  const ts = parseInt(timestamp, 10);
  if (!Number.isFinite(ts)) return false;
  // Reject if older than 5 minutes (replay protection).
  if (Math.abs(Date.now() / 1000 - ts) > 300) return false;

  const signedString = `${timestamp}.${rawBody}`;
  const expected = crypto.createHmac("sha256", secret).update(signedString).digest("hex");
  const expectedHeader = `sha256=${expected}`;

  if (signature.length !== expectedHeader.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedHeader));
  } catch {
    return false;
  }
}
