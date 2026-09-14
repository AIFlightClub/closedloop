# Fixture manifest

- `closedloop-project.md`, `sync-04*`, `sync-05*`, `sync-06*`: copied from `polly/examples/project/` in the existing repo.
- `config.json`: canonical display cast, agenda, timezone and meeting schedule. No real emails or Zoom identities invented.
- `transcript.jsonl`: new controlled seven-minute scenario; `t` is milliseconds since replay start. Sharjeel is absent; only Obaid, Zaid and Nouman speak.
- `extractions.json`: labeled structured extraction output corresponding to exact transcript evidence. Used only for deterministic offline replay.
- `expected-events.json`: replay acceptance events.

The owner example already includes a date; the date example already includes an owner. A both-missing action is tested separately in the engine suite. Seed history is kept intact; changing the current demo cast does not rewrite historical notes.
