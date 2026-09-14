import { createHash, createDecipheriv } from "node:crypto";
// Zoom AES-GCM envelope. Only verified claims may grant access.
export function verifyContext(
  encoded,
  { secret, clientId, now = Date.now() } = {},
) {
  if (!secret || !clientId)
    throw Error("Zoom app credentials are not configured");
  if (typeof encoded !== "string" || encoded.length > 16384)
    throw Error("Missing Zoom context");
  const b = Buffer.from(encoded, "base64url");
  let offset = 0;
  const take = (n) => {
    if (!Number.isInteger(n) || n < 0 || offset + n > b.length)
      throw Error("Invalid context envelope");
    const v = b.subarray(offset, offset + n);
    offset += n;
    return v;
  };
  const iv = take(take(1).readUInt8());
  const aad = take(take(2).readUInt16LE());
  const data = take(take(4).readUInt32LE());
  const tag = take(16);
  if (offset !== b.length) throw Error("Invalid context length");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    createHash("sha256").update(secret).digest(),
    iv,
  );
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  const c = JSON.parse(
    Buffer.concat([decipher.update(data), decipher.final()]).toString(),
  );
  // Zoom versions have represented expiration in milliseconds or epoch seconds.
  const ms = (n) => (n < 1e11 ? n * 1000 : n);
  const exp = ms(c.exp),
    ts = ms(c.ts);
  if (
    c.iss !== "marketplace.zoom.us" ||
    c.aud !== clientId ||
    c.typ !== "meeting" ||
    !c.mid ||
    !c.uid ||
    !Number.isFinite(exp) ||
    exp <= now ||
    !Number.isFinite(ts) ||
    ts > now + 5000 ||
    now - ts > 30000
  )
    throw Error("Invalid or stale Zoom context; refresh it");
  return {
    zoomUserId: c.uid,
    meetingId: c.mid,
    role: ["host", "co-host"].includes(c.attendrole) ? "organizer" : "attendee",
    issuedAt: ts,
    expiresAt: Math.min(exp, ts + 30000),
  };
}
