import { useState, useRef, useEffect } from "react";
import type { OrganizerView } from "../../shared/types";
import { fmt, kind, type Send } from "../ui";
import type { ZoomConnection } from "../zoomAdapter";
import Header from "./Header";
import Intervention from "./Intervention";
export default function Organizer({
  view,
  send,
  controls,
}: {
  view: OrganizerView;
  send: Send;
  controls?: ZoomConnection;
}) {
  const [tab, setTab] = useState("Now");
  const scroll = useRef<HTMLDivElement>(null);
  useEffect(() => {
    scroll.current?.scrollTo(0, 0);
  }, [
    view.activeLoopId,
    view.loops.find((l) => l.id === view.activeLoopId)?.status,
  ]);
  const loops = view.loops.filter(
      (l) => l.status !== "closed" && l.status !== "dismissed",
    ),
    closed = view.loops.filter((l) => l.status === "closed"),
    active = view.loops.find((l) => l.id === view.activeLoopId),
    covered = view.agenda.filter((a) => a.status === "covered").length;
  const left = Date.parse(view.meeting.scheduledEndAt) - view.serverNow;
  const health =
    view.health === "info"
      ? "Resolving"
      : view.health === "ok"
        ? "On track"
        : loops.length === 1
          ? "1 open loop"
          : `${loops.length} loops open`;
  return (
    <section className="panel organizer" aria-label="Organizer panel">
      <Header controls={controls} />
      <nav className="tabs">
        {["Now", "Outcomes"].map((t) => (
          <button
            key={t}
            className={t === tab ? "active" : ""}
            onClick={() => setTab(t)}
          >
            {t}
          </button>
        ))}
      </nav>
      <div className="panel-scroll" ref={scroll}>
        <div className="meeting-heading">
          <h2>{view.meeting.title}</h2>
          <p className="meta clock">
            {fmt(view.serverNow - Date.parse(view.meeting.startedAt))} elapsed ·{" "}
            {fmt(left)} {left >= 0 ? "left" : "over time"}
          </p>
        </div>
        {tab === "Now" ? (
          <>
            {view.detectorError && (
              <div role="status" className="error">
                {view.detectorError}. Existing loops remain available.
              </div>
            )}
            <div className={`health ${view.health}`}>
              <span>
                <i />
                Meeting health
              </span>
              <b>{health}</b>
            </div>
            {active && (
              <Intervention
                key={`${active.id}:${active.status}`}
                loop={active}
                view={view}
                send={send}
              />
            )}
            <section className="section agenda">
              <div className="section-heading">
                <h3>Agenda</h3>
                <span>
                  {covered} of {view.agenda.length} covered
                </span>
              </div>
              <div className="progress">
                <i
                  style={{
                    width: `${view.agenda.length ? (100 * covered) / view.agenda.length : 0}%`,
                  }}
                />
              </div>
              {view.agenda.map((a) => (
                <button
                  key={a.id}
                  className={`agenda-row ${a.status}`}
                  title={
                    a.manual
                      ? "Manually corrected"
                      : "Click to correct coverage"
                  }
                  onClick={() =>
                    send({
                      type: "agenda",
                      id: a.id,
                      status: a.status === "covered" ? "uncovered" : "covered",
                    })
                  }
                >
                  <span>
                    {a.status === "covered"
                      ? "✓"
                      : a.status === "current"
                        ? "→"
                        : "○"}
                  </span>
                  {a.label}
                  {a.manual && <small>edited</small>}
                </button>
              ))}
            </section>
            <section className="section">
              <div className="section-heading">
                <h3>People</h3>
                {!view.people.ready && <span>Connecting…</span>}
              </div>
              <div className="people-row">
                <div className="avatars">
                  {view.people.required.map((p, i) => (
                    <span
                      key={p.id}
                      title={p.name}
                      className={`avatar color-${i} ${view.people.absent.some((a) => a.id === p.id) ? "absent" : ""}`}
                    >
                      {p.name.slice(0, 2).toUpperCase()}
                    </span>
                  ))}
                </div>
                <div>
                  {view.people.required.length} required ·{" "}
                  {view.people.present.length - view.people.extra.length}{" "}
                  present
                  {view.people.ready && view.people.absent.length > 0 && (
                    <div className="absent-line">
                      {view.people.absent.length} absent:{" "}
                      {view.people.absent.map((p) => p.name).join(", ")}
                    </div>
                  )}
                </div>
              </div>
              {view.people.extra.length > 0 && (
                <p className="meta">
                  Also here: {view.people.extra.map((p) => p.name).join(", ")}
                </p>
              )}
            </section>
            <details className="section ledger" open>
              <summary>
                Open loops <span className="count">{loops.length}</span>
              </summary>
              {loops.length ? (
                loops.map((l) => (
                  <button
                    key={l.id}
                    className="ledger-row ledger-action"
                    onClick={() => send({ type: "review", loopId: l.id })}
                  >
                    <i className="open-dot" />
                    <span>
                      {l.item}
                      <small>
                        {kind(l)}
                        {l.status === "deferred" ? " · Follow-up needed" : ""}
                      </small>
                    </span>
                  </button>
                ))
              ) : (
                <p className="meta">No critical issues</p>
              )}
            </details>
            <details className="section ledger">
              <summary>
                Resolved <span className="count">{closed.length}</span>
              </summary>
              {closed.map((l) => (
                <div key={l.id} className="ledger-row">
                  <span className="green">✓</span>
                  <span>
                    {l.item}
                    <small>{l.resolution?.label}</small>
                  </span>
                </div>
              ))}
            </details>
            {left <= 120000 && loops.length > 0 && (
              <div className="card info wrap">
                <div className="section-label">Up next</div>
                <p>
                  {left > 0 ? "2 minutes remaining." : "Meeting is over time."}{" "}
                  {loops.length} {loops.length === 1 ? "loop is" : "loops are"}{" "}
                  still open.
                </p>
                <p className="meta">
                  Unresolved items are retained for follow-up.
                </p>
              </div>
            )}
          </>
        ) : (
          <section className="outcomes">
            <div className="section-label">Meeting outcomes</div>
            <h2>Make the meeting count.</h2>
            {[
              ["Loops closed", closed.length],
              [
                "Owners confirmed",
                closed.filter((l) => l.kind === "owner_missing").length,
              ],
              [
                "Dates confirmed",
                closed.filter((l) => l.kind === "date_missing").length,
              ],
              ["Agenda covered", `${covered}/${view.agenda.length}`],
            ].map(([label, value]) => (
              <div className="metric" key={label}>
                <span>{label}</span>
                <b>{value}</b>
              </div>
            ))}
            <p className="meta">
              LoopIn measures whether this meeting produced complete outcomes —
              not just what was said.
            </p>
          </section>
        )}
      </div>
      <footer className="panel-footer">
        <span className="inline">
          <span className={`listening ${view.listening ? "on" : ""}`}>
            <i />
            <i />
            <i />
          </span>
          {view.listening ? (
            "LoopIn is listening"
          ) : controls ? (
            <button
              className="start-listening"
              onClick={() => controls.startListening()}
            >
              Start listening
            </button>
          ) : (
            "Waiting for transcript"
          )}
        </span>
        <span>
          {view.contextSource === "Slack"
            ? "Context loaded from Slack"
            : "Project context loaded"}
        </span>
      </footer>
    </section>
  );
}
