import type { Command, Loop } from "../shared/types";
export const mark = (
  <svg
    width="20"
    height="20"
    viewBox="0 0 24 24"
    fill="none"
    aria-hidden="true"
  >
    <path
      d="M12 3a9 9 0 1 1-7.8 4.5"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
    />
  </svg>
);
export const fmt = (ms: number) => {
  const s = Math.floor(Math.abs(ms) / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
export const kind = (l: Loop) =>
  l.kind === "owner_missing" ? "Owner missing" : "Date missing";
export type Send = (c: Command) => Promise<void>;
