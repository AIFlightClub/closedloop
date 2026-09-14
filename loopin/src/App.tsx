import { useState, useEffect, useMemo } from "react";
import type { Command, OrganizerView, View } from "../shared/types";
import { Demo, scenes, sceneIds } from "./demo";
import { connectZoom, type ZoomConnection } from "./zoomAdapter";
import { mark, type Send } from "./ui";
import Organizer from "./components/Organizer";
import Attendee from "./components/Attendee";
function Tiles({ demo }: { demo: Demo }) {
  return (
    <div className="meeting-stage">
      <div className="tiles">
        {["Obaid", "Zaid", "Nouman"].map((name, i) => (
          <div className={`tile tile-${i}`} key={name}>
            <span className={`big-avatar color-${i}`}>
              {name.slice(0, 2).toUpperCase()}
            </span>
            <span className="tile-name">
              {name}
              {i === 0 ? " (You)" : ""}{" "}
              <small>{i === 1 ? "speaking" : ""}</small>
            </span>
            <span className="mic">♩</span>
          </div>
        ))}
        <div className="tile empty-tile">
          <span className="empty-ring">{mark}</span>
          <p>Keep the conversation moving.</p>
        </div>
      </div>
      <div className="transcript-caption">
        {demo.index === 0
          ? "“The RTMS stream is ready. Let’s walk through the open items.”"
          : demo.engine.state.loops[0]?.evidence}
      </div>
    </div>
  );
}
export default function App() {
  const params = new URLSearchParams(location.search),
    live = params.get("mode") === "live";
  const demo = useMemo(() => new Demo(), []);
  const [, render] = useState(0),
    [layout, setLayout] = useState(params.get("view") || "both"),
    [error, setError] = useState(""),
    [connection, setConnection] = useState<ZoomConnection>(),
    [liveView, setLiveView] = useState<View>(),
    [connected, setConnected] = useState(false),
    [replay, setReplay] = useState(false);
  useEffect(() => {
    const fn = () => render((n) => n + 1);
    demo.listeners.add(fn);
    const initial = sceneIds.indexOf(params.get("scene") || "");
    if (initial >= 0) demo.reset(initial);
    return () => {
      demo.listeners.delete(fn);
    };
  }, [demo]);
  useEffect(() => {
    if (!live) return;
    let disposed = false;
    let c: ZoomConnection | undefined;
    connectZoom(
      (v) => {
        if (!disposed) setLiveView(v);
      },
      setConnected,
      setError,
    )
      .then((value) => {
        c = value;
        if (disposed) value.dispose();
        else setConnection(value);
      })
      .catch((e) => setError(e.message));
    return () => {
      disposed = true;
      c?.dispose();
    };
  }, [live]);
  useEffect(() => {
    if (!replay) return;
    const id = setInterval(() => {
      if (demo.index >= scenes.length - 1) {
        setReplay(false);
        return;
      }
      demo.reset(demo.index + 1);
    }, 7000);
    return () => clearInterval(id);
  }, [replay, demo]);
  const safe =
    (role: string, id: string): Send =>
    async (c) => {
      setError("");
      try {
        if (live) {
          if (!connection || !connected)
            throw Error(
              "Connection lost. Wait for reconnection before answering.",
            );
          await connection.send(c);
        } else await demo.send(c, role, id);
      } catch (e) {
        setError((e as Error).message);
        throw e;
      }
    };
  // Event handlers consume failures after the global banner is set.
  const send =
    (role: string, id: string): Send =>
    async (c) => {
      try {
        await safe(role, id)(c);
      } catch {}
    };
  if (live)
    return (
      <div className="live-root">
        {error && (
          <div role="alert" className="error">
            {error}
          </div>
        )}
        {!liveView ? (
          <div className="connection-screen">
            {mark}
            <h2>Connecting to your meeting</h2>
            <p>Open LoopIn from a Zoom meeting with the app configured.</p>
          </div>
        ) : (
          <>
            {!connected && (
              <div className="connection-banner">
                Reconnecting… Responses are paused.
              </div>
            )}
            {liveView.role === "organizer" ? (
              <Organizer
                view={liveView}
                send={send(liveView.role, liveView.userId)}
                controls={connection}
              />
            ) : (
              <Attendee
                prompt={liveView.prompt}
                send={safe(liveView.role, liveView.userId)}
                controls={connection}
              />
            )}
          </>
        )}
      </div>
    );
  const organizer = demo.view("organizer", "obaid") as OrganizerView;
  const attendee = demo.view("attendee", "nouman");
  return (
    <main className={`demo-root layout-${layout}`}>
      <div className="demo-top">
        <span className="brand">
          {mark}
          <b>LoopIn</b>
          <span className="demo-tag">Interactive demo</span>
        </span>
        <span>Better meetings. Complete outcomes.</span>
      </div>
      {error && (
        <div role="alert" className="error">
          {error}
        </div>
      )}
      <div className="demo-views">
        {layout !== "attendee" && (
          <div className="view-block organizer-block">
            <div className="view-label">
              <b>Organizer view</b>
              <span>Obaid · Meeting host</span>
            </div>
            <div className="zoom-window">
              <div className="zoom-title">
                <span className="traffic">
                  <i />
                  <i />
                  <i />
                </span>
                <b>ClosedLoop Sync</b>
                <span className="record-dot" /> <small>Rec</small>
                <span className="encrypted">◇ Meeting in progress</span>
              </div>
              <div className="zoom-main">
                <Tiles demo={demo} />
                <Organizer view={organizer} send={send("organizer", "obaid")} />
              </div>
              <div className="zoom-toolbar">
                <span>
                  ♩<small>Mute</small>
                </span>
                <span>
                  ▣<small>Video</small>
                </span>
                <span>
                  ♧<small>Participants</small>
                </span>
                <span>
                  ▤<small>Chat</small>
                </span>
                <span>
                  ↑<small>Share</small>
                </span>
                <span className="apps-selected">
                  ▦<small>Apps</small>
                </span>
                <span
                  className="mock-end"
                  aria-label="Zoom End control, decorative"
                >
                  End
                </span>
              </div>
            </div>
          </div>
        )}
        {layout !== "organizer" && (
          <div className="view-block attendee-block">
            <div className="view-label">
              <b>Attendee view</b>
              <span>Nouman · No organizer dashboard</span>
            </div>
            <Attendee
              prompt={attendee.role === "attendee" ? attendee.prompt : null}
              send={safe("attendee", "nouman")}
            />
            {demo.engine.state.loops.some(
              (l) => l.poll?.status === "active",
            ) && (
              <button
                className="demo-vote"
                onClick={() => {
                  const l = demo.engine.state.loops.find(
                    (l) => l.poll?.status === "active",
                  )!;
                  void send(
                    "attendee",
                    "zaid",
                  )({
                    type: "vote",
                    loopId: l.id,
                    pollId: l.poll!.id,
                    optionId:
                      l.options.find((o) => o.id === "person:zaid")?.id ||
                      l.options[0].id,
                  });
                }}
              >
                Simulate Zaid’s response
              </button>
            )}
          </div>
        )}
      </div>
      <div className="demo-controls">
        <div className="scene-info">
          <span className="section-label">Offline scene player</span>
          <strong>{scenes[demo.index]}</strong>
          <small>
            {demo.index + 1} / {scenes.length}
          </small>
        </div>
        <div className="segmented dark">
          {["both", "organizer", "attendee"].map((v) => (
            <button
              className={layout === v ? "selected" : ""}
              key={v}
              onClick={() => setLayout(v)}
            >
              {v[0].toUpperCase() + v.slice(1)}
            </button>
          ))}
        </div>
        <div className="scene-buttons">
          <button
            disabled={demo.index === 0}
            onClick={() => demo.reset(demo.index - 1)}
          >
            Back
          </button>
          <button
            className="next"
            disabled={demo.index === scenes.length - 1}
            onClick={() => demo.reset(demo.index + 1)}
          >
            Skip ahead →
          </button>
          <button
            onClick={() => {
              setReplay(false);
              demo.reset(0);
            }}
          >
            Restart
          </button>
        </div>
      </div>
      <div className="demo-bottom">
        <span>
          Simulated meeting · No Zoom, Wi-Fi or external polls required
        </span>
        <div>
          <button onClick={() => setReplay(!replay)}>
            {replay ? "Pause replay" : "Play accelerated scenes"}
          </button>
          <button
            disabled={!demo.engine.state.activeLoopId}
            onClick={() => demo.verbal()}
          >
            Resolve verbally
          </button>
          <button onClick={() => demo.advance()}>Advance clock +60s</button>
        </div>
      </div>
    </main>
  );
}
