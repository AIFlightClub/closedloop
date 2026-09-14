import { useState, useEffect } from "react";
import type { Prompt } from "../../shared/types";
import { mark, type Send } from "../ui";
import type { ZoomConnection } from "../zoomAdapter";
import Header from "./Header";
export default function Attendee({
  prompt,
  send,
  controls,
}: {
  prompt: Prompt | null;
  send: Send;
  controls?: ZoomConnection;
}) {
  const [opened, setOpened] = useState(false),
    [sent, setSent] = useState(false),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    setOpened(false);
    if (prompt) setSent(false);
  }, [prompt?.pollId]);
  useEffect(() => {
    if (sent) {
      const id = setTimeout(() => setSent(false), 3000);
      return () => clearTimeout(id);
    }
  }, [sent]);
  return (
    <section className="panel attendee" aria-label="Attendee panel">
      <Header controls={controls} />
      <div className="attendee-content">
        {sent ? (
          <div className="attendee-empty confirmation">
            <div className="check-circle">✓</div>
            <h3>Sent to LoopIn.</h3>
            <p>Your vote is counted. Results stay in the meeting.</p>
          </div>
        ) : !prompt || prompt.answered ? (
          <div className="attendee-empty">
            <span className="idle-mark">{mark}</span>
            <h3>Nothing needs your input.</h3>
            <p>
              LoopIn will prompt you here if the organizer asks the room. You
              won't see the meeting dashboard.
            </p>
          </div>
        ) : !opened ? (
          <div className="attendee-notice">
            <div className="inline blue">
              {mark}
              <b>LoopIn wants your input</b>
            </div>
            <p>“{prompt.question}”</p>
            <button className="primary" onClick={() => setOpened(true)}>
              Give input
            </button>
          </div>
        ) : (
          <div className="answer">
            <h3>{prompt.question}</h3>
            {prompt.options.map((o) => (
              <button
                disabled={busy}
                className="answer-option"
                key={o.id}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await send({
                      type: "vote",
                      loopId: prompt.loopId,
                      pollId: prompt.pollId,
                      optionId: o.id,
                    });
                    setSent(true);
                  } catch {
                    /* Error is displayed by transport. */
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {o.label}
              </button>
            ))}
            <p className="privacy-note">
              The organizer sees response counts. Your panel is private.
            </p>
          </div>
        )}
      </div>
      <footer className="attendee-footer">Only you see this</footer>
    </section>
  );
}
