import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createServer } from "node:http";
import { WebSocket } from "ws";
import { createService } from "../service.js";
import config from "../../fixtures/config.json" with { type: "json" };
test("HTTP and WebSocket round trip with server-side authorization", async (t) => {
  const app = express(),
    server = createServer(app);
  const service = createService({
    config,
    verify: (token) => ({
      meetingId: config.meeting.id,
      zoomUserId: token,
      role: token === "obaid" ? "organizer" : "attendee",
      expiresAt: Date.now() + 30000,
    }),
    identity: (uid) => uid,
  });
  app.use("/loopin", service.router);
  service.attach(server);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => {
    service.close();
    server.close();
  });
  const base = `http://127.0.0.1:${server.address().port}/loopin/api`;
  const call = async (path, who, body) =>
    fetch(base + path, {
      method: body ? "POST" : "GET",
      headers: {
        "x-zoom-app-context": who,
        "content-type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  assert.equal(
    (await call("/roster", "zaid", { participants: config.required })).status,
    403,
  );
  assert.equal(
    (await call("/roster", "obaid", { participants: config.required })).status,
    200,
  );
  service.engine.extract({
    actionId: "x",
    item: "Launch review",
    owner: null,
    due: "2026-09-18",
    evidence: "We should do a launch review by Friday.",
  });
  const state = await (await call("/state", "zaid")).json();
  assert.equal(state.loops, undefined);
  const ws = new WebSocket(base.replace("http", "ws").replace("/api", "/ws"));
  await new Promise((r) => ws.on("open", r));
  t.after(() => ws.terminate());
  const first = new Promise((r) => ws.once("message", (x) => r(JSON.parse(x))));
  ws.send(JSON.stringify({ type: "auth", context: "zaid" }));
  assert.equal((await first).role, "attendee");
  const next = new Promise((r) => ws.once("message", (x) => r(JSON.parse(x))));
  await call("/command", "obaid", {
    type: "send",
    loopId: "L-01",
    audience: ["zaid"],
    requestId: "test",
  });
  const prompt = (await next).prompt;
  assert.equal(prompt.loopId, "L-01");
  await call("/command", "zaid", {
    type: "vote",
    loopId: "L-01",
    pollId: prompt.pollId,
    optionId: "person:zaid",
  });
  assert.equal(service.engine.state.loops[0].status, "closed");
});
test("newer demotion cannot be undone by replaying old host context", async (t) => {
  const app = express(),
    server = createServer(app);
  const service = createService({
    config,
    verify: (token) => ({
      meetingId: config.meeting.id,
      zoomUserId: "obaid",
      role: token === "old" ? "organizer" : "attendee",
      issuedAt: token === "old" ? 1 : 2,
      expiresAt: Date.now() + 30000,
    }),
    identity: (uid) => uid,
  });
  app.use("/loopin", service.router);
  service.attach(server);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => {
    service.close();
    server.close();
  });
  const base = `http://127.0.0.1:${server.address().port}/loopin/api/state`;
  for (const [token, status] of [
    ["old", 200],
    ["new", 200],
    ["old", 401],
  ])
    assert.equal(
      (await fetch(base, { headers: { "x-zoom-app-context": token } })).status,
      status,
    );
});
test("malformed WebSocket Origin is rejected without taking down HTTP", async (t) => {
  const app = express(),
    server = createServer(app);
  const service = createService({
    config,
    verify: () => ({
      meetingId: config.meeting.id,
      zoomUserId: "obaid",
      role: "organizer",
      expiresAt: Date.now() + 30000,
    }),
    identity: (uid) => uid,
  });
  app.use("/loopin", service.router);
  service.attach(server);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => {
    service.close();
    server.close();
  });
  const port = server.address().port;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/loopin/ws`, {
    origin: "not a URL",
  });
  await new Promise((resolve) => ws.on("error", resolve));
  const r = await fetch(`http://127.0.0.1:${port}/loopin/api/state`, {
    headers: { "x-zoom-app-context": "obaid" },
  });
  assert.equal(r.status, 200);
});
test("oversized unauthenticated WebSocket message cannot crash the server", async (t) => {
  const app = express(),
    server = createServer(app);
  const service = createService({
    config,
    verify: () => ({
      meetingId: config.meeting.id,
      zoomUserId: "obaid",
      role: "organizer",
      expiresAt: Date.now() + 30000,
    }),
    identity: (uid) => uid,
  });
  app.use("/loopin", service.router);
  service.attach(server);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => {
    service.close();
    server.close();
  });
  const port = server.address().port;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/loopin/ws`);
  await new Promise((r) => ws.on("open", r));
  const closed = new Promise((r) => ws.once("close", r));
  ws.send("x".repeat(40000));
  await closed;
  const r = await fetch(`http://127.0.0.1:${port}/loopin/api/state`, {
    headers: { "x-zoom-app-context": "obaid" },
  });
  assert.equal(r.status, 200);
});
