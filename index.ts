import express, { type Request, type Response } from "express";
import crypto from "crypto";

const app = express();
const SECRET = process.env.GITHUB_WEBHOOK_SECRET;
if (!SECRET) throw new Error("GITHUB_WEBHOOK_SECRET is not set");

app.post(
  "/webhooks/github",
  express.raw({ type: "*/*" }),              
  (req: Request, res: Response) => {
    const sig = req.get("X-Hub-Signature-256") || "";
    const expected =
      "sha256=" + crypto.createHmac("sha256", SECRET).update(req.body).digest("hex");

    if (
      sig.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
    ) {
      return res.sendStatus(401);
    }

    res.sendStatus(200);                     

    const event = req.get("X-GitHub-Event");
    const delivery = req.get("X-GitHub-Delivery");
    const body: {} = JSON.parse(req.body.toString());

    console.log(event, delivery, body);
  }
);

app.listen(8080);
