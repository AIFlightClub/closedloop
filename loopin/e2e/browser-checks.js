// Runs against Codex's cua Tab Playwright surface. No direct app-state mutation.
// Import in cua_repl and pass a tab already open on the local LoopIn app.
export async function verifyDemo(tab, capture = async () => {}) {
  const ui = tab.playwright;
  const seen = [];
  async function step(name, action) {
    await action();
    await ui.domSnapshot();
    seen.push(name);
  }
  async function visible(locator, message) {
    if (!(await locator.isVisible())) throw Error(message);
  }
  const organizer = ui.locator(".organizer"),
    attendee = ui.locator(".attendee");
  await step("reset", () =>
    ui.getByRole("button", { name: "Restart", exact: true }).click(),
  );
  await visible(
    attendee.getByRole("heading", {
      name: "Nothing needs your input.",
      exact: true,
    }),
    "Idle attendee missing",
  );
  await capture("attendee-idle");
  await step("owner detection", () =>
    ui.getByRole("button", { name: "Skip ahead →", exact: true }).click(),
  );
  await visible(
    organizer.getByRole("heading", { name: "Owner missing", exact: true }),
    "Owner detector card missing",
  );
  await capture("detect-owner-missing");
  await step("compose", () =>
    organizer
      .getByRole("button", { name: "Ask the room", exact: true })
      .click(),
  );
  await visible(
    organizer.getByLabel("Question", { exact: true }),
    "Editable question missing",
  );
  await capture("ask-compose");
  await step("send", () =>
    organizer.getByRole("button", { name: "Send", exact: true }).click(),
  );
  await visible(
    attendee.getByRole("button", { name: "Give input", exact: true }),
    "No attendee prompt",
  );
  await capture("attendee-prompt");
  await capture("asked");
  await step("open prompt", () =>
    attendee.getByRole("button", { name: "Give input", exact: true }).click(),
  );
  await capture("attendee-question");
  await step("vote", () =>
    attendee.getByRole("button", { name: "Zaid", exact: true }).click(),
  );
  await visible(
    attendee.getByRole("heading", { name: "Sent to LoopIn.", exact: true }),
    "Vote confirmation missing",
  );
  await capture("attendee-confirmation");
  if (!(await organizer.innerText()).includes("1 of 3 responded"))
    throw Error("Vote counter not updated");
  await capture("resolving");
  await step("majority", () =>
    ui
      .getByRole("button", { name: "Simulate Zaid’s response", exact: true })
      .click(),
  );
  await visible(
    organizer.getByTestId("resolved-card"),
    "Majority did not close owner loop",
  );
  await capture("resolved");
  await step("continue", () =>
    organizer.getByRole("button", { name: "Continue", exact: true }).click(),
  );
  if ((await organizer.getByTestId("resolved-card").count()) !== 0)
    throw Error("Continue did not dismiss card");
  // Scene skip is a reset, not a shortened detector clock.
  for (let i = 0; i < 4; i++)
    await step("skip scene", () =>
      ui.getByRole("button", { name: "Skip ahead →", exact: true }).click(),
    );
  await visible(
    organizer.getByRole("heading", { name: "Date missing", exact: true }),
    "Date detector card missing",
  );
  await capture("detect-date-missing");
  await step("date compose", () =>
    organizer
      .getByRole("button", { name: "Ask the room", exact: true })
      .click(),
  );
  await step("date send", () =>
    organizer.getByRole("button", { name: "Send", exact: true }).click(),
  );
  await step("date prompt", () =>
    attendee.getByRole("button", { name: "Give input", exact: true }).click(),
  );
  await visible(
    attendee.getByRole("button", { name: "No date needed", exact: true }),
    "Date options missing",
  );
  await step("verbal supersession", () =>
    ui.getByRole("button", { name: "Resolve verbally", exact: true }).click(),
  );
  await visible(
    organizer.getByTestId("resolved-card"),
    "Verbal resolution did not close",
  );
  if (
    await attendee
      .getByRole("button", { name: "No date needed", exact: true })
      .count()
  )
    throw Error("Superseded prompt still visible");
  await capture("date-resolved");
  await step("attendee-only", () =>
    ui.getByRole("button", { name: "Attendee", exact: true }).click(),
  );
  if (await organizer.count())
    throw Error("Dashboard leaked into attendee-only scene");
  await step("both views", () =>
    ui.getByRole("button", { name: "Both", exact: true }).click(),
  );
  return { passed: seen.length, checks: seen };
}
