import test from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { verifyContext } from "../auth.js";
function token(payload) {
  const iv = randomBytes(12),
    aad = Buffer.from("zoom");
  const cipher = createCipheriv(
    "aes-256-gcm",
    createHash("sha256").update("secret").digest(),
    iv,
  );
  cipher.setAAD(aad);
  const data = Buffer.concat([
    cipher.update(JSON.stringify(payload)),
    cipher.final(),
  ]);
  const len = Buffer.alloc(4);
  len.writeUInt32LE(data.length);
  return Buffer.concat([
    Buffer.from([12]),
    iv,
    Buffer.from([4, 0]),
    aad,
    len,
    data,
    cipher.getAuthTag(),
  ]).toString("base64url");
}
const ctx = {
  uid: "zoom-z",
  mid: "meeting",
  attendrole: "host",
  iss: "marketplace.zoom.us",
  aud: "app",
  ts: 1789189200000,
  exp: 1789189300000,
  typ: "meeting",
};
const options = { secret: "secret", clientId: "app", now: 1789189210000 };
test("verified encrypted context supplies identity and role", () =>
  assert.equal(verifyContext(token(ctx), options).role, "organizer"));
test("rejects expired, stale, wrong app and tampered context", () => {
  for (const edit of [
    { exp: 1789189190000 },
    { ts: 0 },
    { aud: "other" },
    { mid: "" },
  ])
    assert.throws(() => verifyContext(token({ ...ctx, ...edit }), options));
  assert.throws(() =>
    verifyContext(token(ctx).slice(0, -5) + "aaaaa", options),
  );
});
test("attendee context cannot assert organizer through extra client fields", () =>
  assert.equal(
    verifyContext(
      token({ ...ctx, attendrole: "participant", role: "organizer" }),
      options,
    ).role,
    "attendee",
  ));
