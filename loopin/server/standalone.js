import express from "express";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createService } from "./service.js";
const app = express(),
  server = createServer(app);
if (process.env.LOOPIN_CONFIG) {
  const config = JSON.parse(readFileSync(process.env.LOOPIN_CONFIG, "utf8"));
  const service = createService({ config });
  app.use("/loopin", service.router);
  service.attach(server);
}
app.use(
  "/loopin",
  express.static(fileURLToPath(new URL("../dist", import.meta.url))),
);
app.get("/", (_req, res) => res.redirect("/loopin/"));
const port = Number(process.env.LOOPIN_PORT || 9798);
server.listen(port, "127.0.0.1", () =>
  console.log(
    `LoopIn: http://127.0.0.1:${port}/loopin/ (offline demo; add ?mode=live for configured Zoom)`,
  ),
);
