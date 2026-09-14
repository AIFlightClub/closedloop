import type { OrganizerView, Command, View, Person, Loop } from "./types";
type Config = {
  meeting: OrganizerView["meeting"];
  required?: Person[];
  agenda?: { id: string; label: string; keywords?: string[] }[];
  contextSource?: string;
};
export class Engine {
  constructor(
    config: Config,
    options?: { now?: () => number; onChange?: () => void },
  );
  state: Omit<OrganizerView, "role" | "userId" | "serverNow">;
  onChange: () => void;
  extract(action: {
    actionId: string;
    item: string;
    owner: string | null;
    due: string | null;
    evidence: string;
  }): void;
  roster(people: Person[]): void;
  command(command: Command, user: { id: string; role: string }): void;
  tick(): void;
  view(user: { id: string; role: string }): View;
}
