import { Engine } from "../shared/engine.js";
import config from "../fixtures/config.json";
import type { Command, View } from "../shared/types";
export const scenes = [
  "Meeting start",
  "Detection — owner missing",
  "Organizer approval",
  "Participant input",
  "Loop resolved",
  "Detection — date missing",
  "Ask for a date",
  "Date poll live",
  "Date resolved",
  "Meeting wrap-up",
];
export const sceneIds = [
  "idle",
  "detect-owner-missing",
  "ask-compose",
  "asked",
  "resolved",
  "detect-date-missing",
  "date-compose",
  "date-asked",
  "date-resolved",
  "wrap-up",
];
export const ownerAction = {
  actionId: "launch-review",
  item: "Prepare the launch review",
  owner: null,
  due: "2026-09-18",
  evidence: "We should prepare the launch review by Friday.",
};
export const dateAction = {
  actionId: "slack-priority",
  item: "Update the priority rankings in the Slack message",
  owner: "nouman",
  due: null,
  evidence: "I’ll update the priority rankings in the Slack message.",
};
export class Demo {
  engine!: Engine;
  time = 0;
  index = 0;
  listeners = new Set<() => void>();
  constructor() {
    this.reset(0);
  }
  reset(index: number) {
    this.index = index;
    this.time = Date.parse(config.meeting.startedAt) + 12 * 60000;
    this.engine = new Engine(config, {
      now: () => this.time,
      onChange: () => {},
    });
    this.engine.roster(config.required.slice(0, 3));
    this.engine.state.listening = true;
    this.engine.state.agenda[0].status = "covered";
    this.engine.state.agenda[1].status = "covered";
    this.engine.state.agenda[2].status = "current";
    if (index > 0) {
      this.engine.extract(index >= 5 ? dateAction : ownerAction);
      this.time += 60000;
      this.engine.tick();
    }
    if ([2, 6].includes(index))
      this.engine.command(
        { type: "compose", loopId: "L-01" },
        { id: "obaid", role: "organizer" },
      );
    if ([3, 4, 7, 8].includes(index)) {
      this.engine.command(
        {
          type: "send",
          loopId: "L-01",
          audience: ["obaid", "zaid", "nouman"],
          requestId: "scene",
        },
        { id: "obaid", role: "organizer" },
      );
    }
    if ([4, 8].includes(index)) {
      const l = this.engine.state.loops[0];
      const optionId = index === 4 ? "person:zaid" : l.options[0].id;
      for (const id of ["zaid", "nouman"])
        this.engine.command(
          { type: "vote", loopId: l.id, pollId: l.poll!.id, optionId },
          { id, role: "attendee" },
        );
    }
    if (index === 9) {
      this.time = Date.parse(config.meeting.scheduledEndAt) - 110000;
      this.engine.state.activeLoopId = null;
    }
    this.engine.onChange = () => this.emit();
    this.emit();
  }
  emit() {
    this.listeners.forEach((f) => f());
  }
  view(role: string, id: string) {
    return this.engine.view({ role, id }) as View;
  }
  async send(c: Command, role: string, id: string) {
    this.engine.command(c, { role, id });
  }
  verbal() {
    const l = this.engine.state.loops.find(
      (l) => l.id === this.engine.state.activeLoopId,
    );
    if (l)
      this.engine.extract(
        l.kind === "owner_missing"
          ? { ...ownerAction, owner: "zaid" }
          : { ...dateAction, due: "2026-09-18" },
      );
  }
  advance() {
    this.time += 60000;
    this.engine.tick();
    this.emit();
  }
}
