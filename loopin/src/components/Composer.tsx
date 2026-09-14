import { useState } from "react";
import type { Loop, OrganizerView } from "../../shared/types";
import type { Send } from "../ui";
export default function Composer({
  loop,
  view,
  send,
}: {
  loop: Loop;
  view: OrganizerView;
  send: Send;
}) {
  const [question, setQuestion] = useState(loop.question),
    [audience, setAudience] = useState(
      view.people.present.filter((p) => p.canVote !== false).map((p) => p.id),
    ),
    [follow, setFollow] = useState(true),
    [busy, setBusy] = useState(false);
  return (
    <div className="card compose">
      <div className="card-head">Ask participants</div>
      <div className="card-body">
        <label className="sr-only" htmlFor="question">
          Question
        </label>
        <textarea
          id="question"
          maxLength={300}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
        />
        <div className="option-preview">
          {loop.options.map((o) => (
            <span key={o.id}>{o.label}</span>
          ))}
        </div>
        <div className="section-label">Audience</div>
        <div className="segmented">
          <button
            onClick={() =>
              setAudience(
                view.people.present
                  .filter((p) => p.canVote !== false)
                  .map((p) => p.id),
              )
            }
            className={
              audience.length === view.people.present.length ? "selected" : ""
            }
          >
            Everyone
          </button>
          <span>Select participants</span>
        </div>
        <div className="audience-list">
          {view.people.present.map((p) => (
            <label key={p.id}>
              <input
                type="checkbox"
                disabled={p.canVote === false}
                checked={audience.includes(p.id)}
                onChange={(e) =>
                  setAudience(
                    e.target.checked
                      ? [...audience, p.id]
                      : audience.filter((id) => id !== p.id),
                  )
                }
              />
              <span className="avatar tiny">{p.name[0]}</span>
              {p.name}
              {p.canVote === false && (
                <small> · app access not configured</small>
              )}
            </label>
          ))}
        </div>
        <label className="followup">
          <input
            type="checkbox"
            checked={follow}
            onChange={(e) => setFollow(e.target.checked)}
          />
          Also ask absent required participants after the meeting
        </label>
        <button
          className="primary"
          disabled={busy || !audience.length || !question.trim()}
          onClick={async () => {
            setBusy(true);
            try {
              await send({
                type: "send",
                loopId: loop.id,
                question,
                audience,
                followupAbsent: follow,
                requestId: crypto.randomUUID(),
              });
            } catch {
              /* Error banner retains this form. */
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Sending…" : "Send"}
        </button>
        <button
          className="quiet full"
          onClick={() => send({ type: "cancel", loopId: loop.id })}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
