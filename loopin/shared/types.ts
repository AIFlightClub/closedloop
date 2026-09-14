export type Person = {
  id: string;
  name: string;
  email?: string;
  participantId?: string;
  zoomUserId?: string;
  canVote?: boolean;
};
export type Option = { id: string; label: string; value: string | null };
export type Poll = {
  id: string;
  status: "active" | "closed" | "superseded" | "expired" | "cancelled";
  audience: string[];
  options: Option[];
  myResponse?: string | null;
  responses: { personId?: string; optionId: string; at?: number }[];
  expiresAt: number;
};
export type Loop = {
  id: string;
  actionId: string;
  kind: "owner_missing" | "date_missing";
  status: "open" | "asking" | "awaiting" | "closed" | "dismissed" | "deferred";
  item: string;
  evidence: string;
  detectedAt: number;
  eligibleAt: number;
  surfacedAt: number | null;
  question: string;
  options: Option[];
  poll: Poll | null;
  followupAbsent: boolean;
  resolution?: {
    value: string;
    label: string;
    source: "verbal" | "poll" | "organizer";
    at: number;
    confirmedBy: number;
  };
};
export type Agenda = {
  id: string;
  label: string;
  status: "covered" | "current" | "uncovered";
  confidence: number;
  manual: boolean;
};
export type Prompt = {
  loopId: string;
  pollId: string;
  question: string;
  options: Option[];
  answered: boolean;
};
export type OrganizerView = {
  role: "organizer";
  userId: string;
  revision: number;
  serverNow: number;
  meeting: {
    id: string;
    title: string;
    startedAt: string;
    scheduledEndAt: string;
    timezone: string;
  };
  people: {
    required: Person[];
    present: Person[];
    absent: Person[];
    extra: Person[];
    ready: boolean;
  };
  agenda: Agenda[];
  loops: Loop[];
  activeLoopId: string | null;
  health: "ok" | "open" | "attn" | "info";
  listening: boolean;
  contextSource: string;
  detectorError?: string | null;
};
export type AttendeeView = {
  role: "attendee";
  userId: string;
  revision: number;
  meeting: { title: string };
  prompt: Prompt | null;
};
export type View = OrganizerView | AttendeeView;
export type Command = { type: string; [key: string]: unknown };
export type Transport = {
  subscribe: (fn: (view: View) => void) => () => void;
  send: (command: Command) => Promise<void>;
  close: () => void;
};
