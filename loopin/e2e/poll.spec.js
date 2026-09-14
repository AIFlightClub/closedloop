import { test, expect } from "@playwright/test";
import { verifyDemo } from "./browser-checks.js";
test("owner poll, date verbal resolution and role-isolated panels", async ({
  page,
}) => {
  await page.goto("/loopin/");
  const tab = {
    playwright: {
      getByRole: (...args) => page.getByRole(...args),
      locator: (...args) => page.locator(...args),
      domSnapshot: () => page.locator("body").innerText(),
    },
  };
  const result = await verifyDemo(tab);
  expect(result.passed).toBe(18);
});
