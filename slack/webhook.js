import crypto from "node:crypto";

const hmac = (secret, data) => crypto.createHmac("sha256", secret).update(data).digest("hex");

const signaturesMatch = (given, expected) =>
  given.length === expected.length &&
  crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));

/** Validates Slack's HMAC signature and its five-minute replay window. */
export const verifySlackRequest = (req) => {
  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  const timestamp = req.get("x-slack-request-timestamp");
  const signature = req.get("x-slack-signature") || "";
  const timestampSeconds = Number(timestamp);

  return Boolean(
    signingSecret &&
      Number.isFinite(timestampSeconds) &&
      Math.abs(Date.now() / 1000 - timestampSeconds) <= 60 * 5 &&
      signaturesMatch(signature, "v0=" + hmac(signingSecret, `v0:${timestamp}:${req.body}`))
  );
};
