import { useState } from "react";
import type { Loop, OrganizerView } from "../../shared/types";
import { mark, kind, type Send } from "../ui";
import Composer from "./Composer";
export default function Intervention({
  loop,
  view,
  send,
}: {
  loop: Loop;
  view: OrganizerView;
  send: Send;
}) {
  const [assign, setAssign] = useState(false);
  if (loop.status === "asking")
    return <Composer key={loop.id} loop={loop} view={view} send={send} />;
  if (loop.status === "closed")
    return (
      <div className="card success" data-testid="resolved-card">
        <div className="closed-ring">
          <svg width="48" height="48" viewBox="0 0 48 48">
            <circle
              cx="24"
              cy="24"
              r="20"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            />
            <path
              d="m15 24 6 6 12-13"
              fill="none"
              stroke="currentColor"
              strokeWidth="3"
              strokeLinecap="round"
            />
          </svg>
        </div>
        <div className="section-label">Loop closed</div>
        <h3>{loop.item}</h3>
        <p className="decision">
          {loop.kind === "owner_missing" ? "Owner" : "Decision"}:{" "}
          {loop.resolution?.label}
        </p>
        <p className="meta">
          {loop.resolution?.source === "poll"
            ? `Confirmed by ${loop.resolution.confirmedBy} participants`
            : loop.resolution?.source === "verbal"
              ? "Confirmed in the conversation"
              : "Confirmed by organizer"}
        </p>
        <button
          className="primary success-button"
          onClick={() => send({ type: "continue", loopId: loop.id })}
        >
          Continue
        </button>
      </div>
    );
  if (loop.status === "awaiting") {
    const p = loop.poll!;
    return (
      <div className="card info">
        <div className="card-head">
          <span>Asked the room</span>
          <small>
            {p.responses.length} of {p.audience.length} responded
          </small>
        </div>
        <div className="card-body">
          <p className="question">“{loop.question}”</p>
          <div className="progress">
            <i
              style={{
                width: `${(100 * p.responses.length) / p.audience.length}%`,
              }}
            />
          </div>
          <p className="meta">
            Waiting for participants. No one has been interrupted.
          </p>
          <div className="vote-counts">
            {p.options.map((o) => (
              <div key={o.id}>
                <span>{o.label}</span>
                <b>{p.responses.filter((r) => r.optionId === o.id).length}</b>
              </div>
            ))}
          </div>
          {p.audience.includes(view.userId) && !p.myResponse && (
            <label className="host-vote">
              Your response
              <select
                aria-label="Your poll response"
                defaultValue=""
                onChange={(e) =>
                  send({
                    type: "vote",
                    loopId: loop.id,
                    pollId: p.id,
                    optionId: e.target.value,
                  })
                }
              >
                <option value="" disabled>
                  Choose an option
                </option>
                {p.options.map((o) => (
                  <option value={o.id} key={o.id}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      </div>
    );
  }
  return (
    <div className="card warning">
      <div className="card-head">
        <span className="inline">{mark} Open loop</span>
        <small>just now</small>
      </div>
      <div className="card-body">
        <h3>{kind(loop)}</h3>
        <blockquote>“{loop.item}.”</blockquote>
        <p className="meta">
          I heard an action item, but I didn't hear{" "}
          {loop.kind === "owner_missing" ? "an owner" : "a due date"}.
        </p>
        <button
          className="primary"
          onClick={() => send({ type: "compose", loopId: loop.id })}
        >
          Ask the room
        </button>
        <div className="button-row">
          <button className="secondary" onClick={() => setAssign(!assign)}>
            {loop.kind === "owner_missing" ? "Assign owner" : "Set date"}{" "}
            <span>⌄</span>
          </button>
          <button
            className="quiet"
            onClick={() => send({ type: "dismiss", loopId: loop.id })}
          >
            Ignore
          </button>
        </div>
        {assign && (
          <div className="inline-options">
            {loop.options.map((o) => (
              <button
                key={o.id}
                className="secondary full"
                onClick={() =>
                  send({ type: "resolve", loopId: loop.id, optionId: o.id })
                }
              >
                {o.label}
              </button>
            ))}
          </div>
        )}
        <div className="hint">Suggested intervention</div>
      </div>
    </div>
  );
}
