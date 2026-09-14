import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import { z } from "zod";
import { Engine, reconcileRoster } from "../shared/engine.js";
import { verifyContext } from "./auth.js";
import { createDetector } from "./detector.js";
const rosterSchema = z.object({
  participants: z
    .array(
      z.object({
        id: z.string().min(1).max(200),
        name: z.string().min(1).max(200),
        email: z.string().email().optional(),
      }),
    )
    .max(500),
});
export function createService({
  config,
  verify,
  identity,
  extractor,
  log = console.error,
} = {}) {
  if (!config) throw Error("LoopIn meeting config is required");
  const verifyToken =
    verify ||
    ((token) =>
      verifyContext(token, {
        secret: process.env.ZOOM_APP_CLIENT_SECRET,
        clientId: process.env.ZOOM_APP_CLIENT_ID,
      }));
  const clients = new Map(),
    roles = new Map();
  let wss;
  const identities = [...(config.required || []), ...(config.identities || [])];
  const engine = new Engine(config, { onChange: () => broadcast() });
  const detector = createDetector(engine, {
    extractor,
    onError: (e) => {
      engine.state.detectorError = "Transcript extraction unavailable";
      engine.changed();
      log("LoopIn extraction failed: " + e.message);
    },
  });
  const router = express.Router();
  router.use(express.json({ limit: "32kb" }));
  const authenticate = (token) => {
    const claims = verifyToken(token);
    if (claims.meetingId !== config.meeting.id)
      throw Error("Meeting is not configured");
    const person = identities.find((p) => p.zoomUserId === claims.zoomUserId);
    const id = identity ? identity(claims.zoomUserId) : person?.id;
    if (!id) throw Error("Zoom user is not mapped in meeting config");
    const latest = roles.get(claims.zoomUserId);
    if (
      latest &&
      ((claims.issuedAt ?? 0) < latest.issuedAt ||
        ((claims.issuedAt ?? 0) === latest.issuedAt &&
          claims.role !== latest.role))
    )
      throw Error("Stale meeting role");
    roles.set(claims.zoomUserId, {
      role: claims.role,
      issuedAt: claims.issuedAt ?? 0,
    });
    return { ...claims, id };
  };
  function valid(user) {
    return (
      user.expiresAt > Date.now() &&
      roles.get(user.zoomUserId)?.role === user.role
    );
  }
  function broadcast() {
    for (const [ws, user] of clients) {
      if (!valid(user)) {
        ws.close(4001, "Refresh meeting role");
        continue;
      }
      if (ws.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify(engine.view(user)));
    }
  }
  router.use("/api", (req, res, next) => {
    res.set("Cache-Control", "no-store");
    try {
      req.loopinUser = authenticate(req.get("x-zoom-app-context"));
      next();
    } catch (e) {
      res.status(401).json({ error: e.message });
    }
  });
  router.get("/api/state", (req, res) => res.json(engine.view(req.loopinUser)));
  router.post("/api/roster", (req, res) => {
    if (req.loopinUser.role !== "organizer")
      return res
        .status(403)
        .json({ error: "Only the organizer can update the roster" });
    const parsed = rosterSchema.safeParse(req.body);
    if (!parsed.success)
      return res.status(400).json({ error: "Invalid roster" });
    const roster = reconcileRoster(
      identities,
      parsed.data.participants,
    ).present.map((p) => ({
      ...p,
      canVote: identities.some(
        (i) => i.id === p.id && (i.zoomUserId || identity),
      ),
    }));
    engine.roster(roster);
    res.json({ ok: true });
  });
  router.post("/api/command", (req, res) => {
    try {
      if (!req.body || typeof req.body.type !== "string")
        throw Error("Invalid command");
      engine.command(req.body, req.loopinUser);
      res.json({ ok: true, revision: engine.state.revision });
    } catch (e) {
      res
        .status(
          req.loopinUser.role !== "organizer" && req.body?.type !== "vote"
            ? 403
            : 400,
        )
        .json({ error: e.message });
    }
  });
  const tick = setInterval(() => {
    engine.tick();
    broadcast();
  }, 1000);
  tick.unref();
  const streams = new Set();
  return {
    router,
    engine,
    meetingId: config.meeting.id,
    attach(server) {
      wss = new WebSocketServer({ noServer: true, maxPayload: 32768 });
      server.on("upgrade", (req, socket, head) => {
        try {
          if (new URL(req.url, "http://localhost").pathname !== "/loopin/ws") {
            socket.destroy();
            return;
          }
          const origin = req.headers.origin;
          if (origin && new URL(origin).host !== req.headers.host) {
            socket.destroy();
            return;
          }
        } catch {
          socket.destroy();
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws) =>
          wss.emit("connection", ws, req),
        );
      });
      wss.on("connection", (ws) => {
        const timeout = setTimeout(() => {
          if (!clients.has(ws)) ws.close(4001, "Authentication required");
        }, 5000);
        ws.on("message", (raw) => {
          try {
            const m = JSON.parse(raw.toString());
            if (m.type !== "auth") throw Error("Authenticate the connection");
            const user = authenticate(m.context);
            clients.set(ws, user);
            clearTimeout(timeout);
            ws.send(JSON.stringify(engine.view(user)));
          } catch {
            ws.close(4001, "Invalid meeting context");
          }
        });
        ws.on("error", () => {
          clearTimeout(timeout);
          clients.delete(ws);
          ws.terminate();
        });
        ws.on("close", () => {
          clearTimeout(timeout);
          clients.delete(ws);
        });
      });
    },
    startStream(meetingId, streamId) {
      if (meetingId !== config.meeting.id) return;
      streams.add(streamId);
      engine.state.listening = true;
      engine.changed();
    },
    push(meetingId, entry) {
      if (meetingId !== config.meeting.id) return Promise.resolve();
      return detector.push(entry);
    },
    stopStream(meetingId, streamId) {
      if (meetingId !== config.meeting.id) return;
      streams.delete(streamId);
      engine.state.listening = streams.size > 0;
      engine.changed();
    },
    close() {
      clearInterval(tick);
      detector.stop();
      for (const ws of clients.keys()) ws.terminate();
      wss?.close();
    },
  };
}
