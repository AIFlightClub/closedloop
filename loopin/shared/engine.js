// Serializable meeting state. Used by the server and explicitly offline demo only.
const copy = (value) => structuredClone(value);
const normal = (s) =>
  String(s || "")
    .trim()
    .toLowerCase();
const pending = (l) => !["closed", "dismissed"].includes(l.status);
export function reconcileRoster(required, participants) {
  const unique = [...new Map(participants.map((p) => [p.id, p])).values()];
  const claimed = new Set();
  const present = [],
    absent = [];
  for (const person of required) {
    let matches = person.email
      ? unique.filter((p) => normal(p.email) === normal(person.email))
      : [];
    if (!matches.length)
      matches = unique.filter((p) => normal(p.name) === normal(person.name));
    if (matches.length === 1 && !claimed.has(matches[0].id)) {
      claimed.add(matches[0].id);
      present.push({
        ...matches[0],
        id: person.id,
        participantId: matches[0].id,
        name: person.name,
      });
    } else absent.push(person);
  }
  const extra = unique.filter((p) => !claimed.has(p.id));
  return {
    required: copy(required),
    present: [...present, ...extra],
    absent: copy(absent),
    extra,
    ready: true,
  };
}
export function dateOptions(meeting, now) {
  const local = new Intl.DateTimeFormat("en-CA", {
    timeZone: meeting.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(now));
  return [1, 3, 7]
    .map((days) => {
      const d = new Date(local + "T12:00:00Z");
      d.setUTCDate(d.getUTCDate() + days);
      const value = d.toISOString().slice(0, 10);
      return {
        id: "date:" + value,
        label: new Intl.DateTimeFormat("en-GB", {
          weekday: "short",
          day: "numeric",
          month: "short",
          timeZone: "UTC",
        }).format(d),
        value,
      };
    })
    .concat({ id: "no-date", label: "No date needed", value: "not_required" });
}
export class Engine {
  constructor(config, { now = () => Date.now(), onChange = () => {} } = {}) {
    const m = config.meeting;
    if (!m?.scheduledEndAt || !Number.isFinite(Date.parse(m.scheduledEndAt)))
      throw Error("scheduledEndAt is required");
    if (!m.startedAt || !Number.isFinite(Date.parse(m.startedAt)))
      throw Error("startedAt is required");
    new Intl.DateTimeFormat("en", { timeZone: m.timezone });
    this.evidenceVersion = 0;
    this.processedVersion = 0;
    this.now = now;
    this.onChange = onChange;
    this.history = [];
    this.requests = new Set();
    this.actions = new Map();
    this.state = {
      meeting: copy(m),
      people: {
        required: copy(config.required || []),
        present: [],
        absent: [],
        extra: [],
        ready: false,
      },
      agenda: (config.agenda || []).map((a) => ({
        ...a,
        status: "uncovered",
        confidence: 0,
        manual: false,
      })),
      loops: [],
      activeLoopId: null,
      health: "ok",
      revision: 0,
      listening: false,
      contextSource: config.contextSource || "Project fixture",
    };
  }
  changed() {
    const open = this.state.loops.filter(pending);
    this.state.health = open.some((l) => l.status === "awaiting")
      ? "info"
      : open.length > 1
        ? "attn"
        : open.length
          ? "open"
          : "ok";
    this.state.revision++;
    this.onChange(this.state);
  }
  roster(participants) {
    this.state.people = reconcileRoster(
      this.state.people.required,
      participants,
    );
    this.changed();
  }
  extract(a) {
    if (
      !a ||
      !a.actionId ||
      !a.item ||
      !a.evidence ||
      !("owner" in a) ||
      !("due" in a)
    )
      throw Error("Invalid extraction");
    const old = this.actions.get(a.actionId);
    // Null means no new evidence, not revocation of an earlier explicit commitment.
    const action = {
      ...a,
      owner: a.owner ?? old?.owner ?? null,
      due: a.due ?? old?.due ?? null,
    };
    this.actions.set(a.actionId, action);
    for (const [field, kind] of [
      ["owner", "owner_missing"],
      ["due", "date_missing"],
    ]) {
      let l = this.state.loops.find(
        (l) => l.actionId === a.actionId && l.kind === kind,
      );
      if (action[field] !== null) {
        if (l && pending(l)) {
          const value = action[field];
          const label =
            field === "owner"
              ? this.state.people.required
                  .concat(this.state.people.present)
                  .find((p) => p.id === value)?.name || value
              : /^\d{4}-\d{2}-\d{2}$/.test(value)
                ? new Intl.DateTimeFormat("en-GB", {
                    weekday: "short",
                    day: "numeric",
                    month: "short",
                    timeZone: "UTC",
                  }).format(new Date(value + "T12:00:00Z"))
                : value;
          this.resolve(l, { value, label }, "verbal");
        }
        continue;
      }
      if (l) continue;
      const n = this.state.loops.length + 1;
      l = {
        id: "L-" + String(n).padStart(2, "0"),
        actionId: a.actionId,
        kind,
        status: "open",
        item: a.item,
        evidence: a.evidence,
        detectedAt: this.now(),
        eligibleAt: this.now() + 60000,
        surfacedAt: null,
        question:
          field === "owner"
            ? `Who should own “${a.item}”?`
            : `What is the due date for “${a.item}”?`,
        options: [],
        poll: null,
        followupAbsent: true,
      };
      l.options = this.options(l);
      this.state.loops.push(l);
    }
    this.changed();
  }
  options(l) {
    return l.kind === "owner_missing"
      ? this.state.people.present
          .map((p) => ({ id: "person:" + p.id, label: p.name, value: p.id }))
          .concat({
            id: "undecided",
            label: "Someone else / not yet decided",
            value: null,
          })
      : dateOptions(
          this.state.meeting,
          this.now() < 1e11
            ? Date.parse(this.state.meeting.startedAt) + this.now()
            : this.now(),
        );
  }
  tick() {
    const now = this.now();
    let change = false;
    for (const l of this.state.loops) {
      const held = l.poll?.pendingResolution;
      if (
        l.poll?.status === "active" &&
        now < l.poll.expiresAt &&
        held &&
        this.processedVersion >= held.version
      ) {
        const winner = l.poll.options.find((o) => o.id === held.optionId);
        if (
          winner &&
          l.poll.responses.filter((r) => r.optionId === winner.id).length >
            l.poll.audience.length / 2
        ) {
          this.resolve(l, winner, "poll");
          change = true;
        }
        delete l.poll.pendingResolution;
      }
      if (l.poll?.status === "active" && now >= l.poll.expiresAt) {
        l.poll.status = "expired";
        l.status = "deferred";
        if (this.state.activeLoopId === l.id) this.state.activeLoopId = null;
        change = true;
      }
    }
    for (const a of this.state.agenda) {
      if (!a.manual && a.status === "current" && now - a.lastTopicAt >= 30000) {
        a.status = "covered";
        a.coveredAt = now;
        change = true;
      }
    }
    this.history = this.history.filter((t) => now - t < 1800000);
    if (
      !this.state.activeLoopId &&
      this.history.length < 3 &&
      (!this.history.length || now - this.history.at(-1) >= 300000)
    ) {
      const l = this.state.loops
        .filter(
          (l) =>
            l.status === "open" && l.surfacedAt === null && l.eligibleAt <= now,
        )
        .sort(
          (a, b) =>
            (a.kind === "owner_missing" ? 0 : 1) -
            (b.kind === "owner_missing" ? 0 : 1),
        )[0];
      if (l) {
        l.surfacedAt = now;
        l.options = this.options(l);
        this.state.activeLoopId = l.id;
        this.history.push(now);
        change = true;
      }
    }
    if (change) this.changed();
  }
  topic(text) {
    const now = this.now();
    for (const a of this.state.agenda) {
      if (a.manual || a.status === "covered") continue;
      const hits = (
        a.keywords ||
        a.label
          .toLowerCase()
          .split(/\W+/)
          .filter((w) => w.length > 3)
      ).filter((w) => normal(text).includes(normal(w))).length;
      if (!hits) continue;
      if (a.lastTopicAt === undefined || now - a.lastTopicAt > 30000)
        a.topicSince = now;
      a.lastTopicAt = now;
      a.confidence = Math.min(1, hits / 2);
      if (now - a.topicSince >= 45000) a.status = "current";
    }
    this.changed();
  }
  resolve(l, option, source) {
    if (!pending(l)) return;
    if (l.poll?.status === "active")
      l.poll.status = source === "verbal" ? "superseded" : "closed";
    l.status = option.value === null ? "deferred" : "closed";
    if (option.value !== null) {
      const action = this.actions.get(l.actionId);
      if (action)
        action[l.kind === "owner_missing" ? "owner" : "due"] = option.value;
      l.resolution = {
        ...option,
        source,
        at: this.now(),
        confirmedBy:
          l.poll?.responses.filter((r) => r.optionId === option.id).length || 0,
      };
    } else if (this.state.activeLoopId === l.id) this.state.activeLoopId = null;
  }
  command(c, user) {
    if (c.type === "vote") {
      const l = this.state.loops.find((l) => l.id === c.loopId),
        p = l?.poll;
      if (
        !p ||
        p.status !== "active" ||
        p.id !== c.pollId ||
        this.now() >= p.expiresAt
      )
        throw Error("Poll is not active");
      if (!p.audience.includes(user.id)) throw Error("Not in poll audience");
      const option = p.options.find((o) => o.id === c.optionId);
      if (!option) throw Error("Invalid option");
      p.responses = p.responses
        .filter((r) => r.personId !== user.id)
        .concat({ personId: user.id, optionId: c.optionId, at: this.now() });
      const winner = p.options.find(
        (o) =>
          p.responses.filter((r) => r.optionId === o.id).length >
          p.audience.length / 2,
      );
      delete p.pendingResolution;
      if (winner) {
        if (this.processedVersion < this.evidenceVersion)
          p.pendingResolution = {
            optionId: winner.id,
            version: this.evidenceVersion,
          };
        else this.resolve(l, winner, "poll");
      }
      this.changed();
      return;
    }
    if (user.role !== "organizer")
      throw Error("Only the organizer can do this");
    if (c.type === "agenda") {
      const a = this.state.agenda.find((a) => a.id === c.id);
      if (!a || !["covered", "current", "uncovered"].includes(c.status))
        throw Error("Invalid agenda state");
      a.status = c.status;
      a.manual = true;
      this.changed();
      return;
    }
    const l = this.state.loops.find((l) => l.id === c.loopId);
    if (!l) throw Error("Unknown loop");
    if (c.type === "continue") {
      if (!["closed", "dismissed"].includes(l.status))
        throw Error("Loop is still open");
      if (this.state.activeLoopId === l.id) this.state.activeLoopId = null;
      this.changed();
      this.tick();
      return;
    }
    if (c.type === "send" && c.requestId && this.requests.has(c.requestId))
      return;
    if (!pending(l)) throw Error("Loop is not open");
    if (c.type === "review") {
      if (this.state.activeLoopId && this.state.activeLoopId !== l.id)
        throw Error("Finish the active card first");
      this.state.activeLoopId = l.id;
    } else if (c.type === "compose") {
      if (l.poll?.status === "active") throw Error("Poll already active");
      l.status = "asking";
    } else if (c.type === "cancel") {
      if (l.status !== "asking") throw Error("Not composing");
      l.status = "open";
    } else if (c.type === "dismiss") {
      l.status = "dismissed";
      if (l.poll?.status === "active") l.poll.status = "cancelled";
      if (this.state.activeLoopId === l.id) this.state.activeLoopId = null;
    } else if (c.type === "resolve") {
      const option = l.options.find((o) => o.id === c.optionId);
      if (!option) throw Error("Invalid option");
      this.resolve(l, option, "organizer");
    } else if (c.type === "send") {
      if (l.poll?.status === "active") throw Error("Poll already active");
      const audience = [
        ...new Set(
          c.audience ||
            this.state.people.present
              .filter((p) => p.canVote !== false)
              .map((p) => p.id),
        ),
      ];
      if (
        !audience.length ||
        audience.some(
          (id) =>
            !this.state.people.present.some(
              (p) => p.id === id && p.canVote !== false,
            ),
        )
      )
        throw Error("Invalid audience");
      const question = (c.question ?? l.question).trim();
      if (!question || question.length > 300)
        throw Error("Question must be 1–300 characters");
      l.question = question;
      l.followupAbsent = c.followupAbsent !== false;
      l.status = "awaiting";
      l.poll = {
        id: l.id + ":" + this.state.revision,
        status: "active",
        audience,
        options: copy(l.options),
        responses: [],
        expiresAt: this.now() + 120000,
      };
      if (c.requestId) this.requests.add(c.requestId);
    } else throw Error("Unknown command");
    this.changed();
  }
  view(user) {
    if (user.role === "organizer") {
      const state = copy(this.state);
      for (const l of state.loops) {
        if (l.poll) {
          l.poll.myResponse =
            l.poll.responses.find((r) => r.personId === user.id)?.optionId ||
            null;
          l.poll.responses = l.poll.responses.map((r) => ({
            optionId: r.optionId,
          }));
        }
      }
      return {
        ...state,
        role: "organizer",
        userId: user.id,
        serverNow: this.now(),
      };
    }
    const l = this.state.loops.find(
      (l) => l.poll?.status === "active" && l.poll.audience.includes(user.id),
    );
    return {
      role: "attendee",
      userId: user.id,
      revision: this.state.revision,
      meeting: { title: this.state.meeting.title },
      prompt: l
        ? {
            loopId: l.id,
            pollId: l.poll.id,
            question: l.question,
            options: copy(l.poll.options),
            answered: l.poll.responses.some((r) => r.personId === user.id),
          }
        : null,
    };
  }
}
