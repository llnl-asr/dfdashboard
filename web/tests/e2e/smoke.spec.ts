import { expect, test } from "@playwright/test";

// The document theme follows localStorage, and a fresh context has none, so the
// dark cases set it before the first paint.
async function boot(page: import("@playwright/test").Page, theme?: "dark") {
  if (theme) {
    await page.addInitScript((t) => localStorage.setItem("dftracer:theme", t), theme);
  }
  await page.goto("/");
  await expect(page.locator("nav.leftnav")).toBeVisible();
}

test("the shell boots with the run bar and the overview", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(String(e)));

  await boot(page, "dark");

  // The runs bar: two finished runs plus the all-runs chip, no horizontal scroll.
  await expect(page.locator(".runs-bar")).toBeVisible();
  await expect(page.locator(".run-chip").first()).toBeVisible();
  const overflow = await page.evaluate(() => {
    const bar = document.querySelector(".runs-bar") as HTMLElement | null;
    return bar ? bar.scrollWidth - bar.clientWidth : -1;
  });
  expect(overflow).toBe(0);

  // Every overview card paints markup inside its own shadow root.
  await expect
    .poll(
      async () =>
        page.evaluate(
          () =>
            [...document.querySelectorAll('[id^="pcard-"]')].filter((slot) => {
              const root = (slot as HTMLElement).firstElementChild?.shadowRoot;
              return Boolean(root && root.textContent && root.textContent.trim().length > 20);
            }).length,
        ),
      { timeout: 60_000 },
    )
    .toBeGreaterThanOrEqual(10);

  expect(errors).toEqual([]);
});

test("a run chip scopes the view and a stale one is dropped", async ({ page }) => {
  await boot(page, "dark");
  const chip = page.locator(".run-chip").nth(1);
  const label = (await chip.textContent()) ?? "";
  await chip.click();
  await expect(page).toHaveURL(/[?&]run=/);
  await expect(page.locator(".run-chip.active, .run-chip.is-active").first()).toBeVisible({
    timeout: 30_000,
  });

  await page.goto("/?run=ghost_run_that_never_existed");
  await expect(page.locator("nav.leftnav")).toBeVisible();
  await expect(page).not.toHaveURL(/ghost_run_that_never_existed/);
  expect(label.length).toBeGreaterThan(0);
});

test("the timeline and the other views render without errors", async ({ page }) => {
  // A fetch the view supersedes while switching is aborted by the browser and
  // shows up as a console error; that is navigation noise, not a broken view.
  const noise = /Failed to fetch|ERR_ABORTED|net::ERR|AbortError/;
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && !noise.test(m.text()) && errors.push(m.text()));
  page.on("pageerror", (e) => !noise.test(String(e)) && errors.push(String(e)));

  await boot(page, "dark");
  await page.locator('nav.leftnav a[href*="view=timeline"]').first().click();
  await expect(page.locator("canvas").first()).toBeVisible({ timeout: 30_000 });

  for (const view of ["flamegraph", "sandwich", "provenance", "api"]) {
    await page.locator(`nav.leftnav a[href*="view=${view}"]`).first().click();
    await expect(page.locator("nav.leftnav")).toHaveClass(/leftnav/);
    await expect(page).toHaveURL(new RegExp(`view=${view}`));
  }
  expect(errors).toEqual([]);
});

function cardTexts(page: import("@playwright/test").Page) {
  return page.evaluate(
    () =>
      Object.fromEntries(
        [...document.querySelectorAll('[id^="pcard-"]')].map((slot) => [
          (slot as HTMLElement).id,
          (slot as HTMLElement).firstElementChild?.shadowRoot?.textContent ?? "",
        ]),
      ) as Record<string, string>,
  );
}

const paintedCount = (texts: Record<string, string>) =>
  Object.values(texts).filter((t) => t.trim().length > 20).length;

test("the window filter reaches the cards and the label follows", async ({ page }) => {
  const embeds: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/panel/cards/embed")) embeds.push(decodeURIComponent(r.url()));
  });
  await boot(page, "dark");

  // The cards paint over the whole trace first, so the numbers a reader sees are
  // the full-trace ones until the window moves.
  await expect
    .poll(async () => paintedCount(await cardTexts(page)), { timeout: 60_000 })
    .toBeGreaterThan(5);

  const filter = page.locator(".rangefilter");
  await expect(filter).toBeVisible();
  const labelBefore = (await filter.locator(".rangefilter-label").textContent()) ?? "";
  const seenBefore = embeds.length;

  // fill() does not raise the event a range slider needs; Solid listens on
  // "input", so set the value and dispatch it.
  await page.evaluate(() => {
    const el = document.querySelector(".rangefilter input[type='range']") as HTMLInputElement;
    el.value = "330";
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });

  await expect(filter.locator(".rangefilter-label")).not.toHaveText(labelBefore);

  // A narrowed window must reach the cards: the embed that carries them is
  // re-requested with a begin inside the trace, and they still paint after it.
  await expect
    .poll(() => embeds.slice(seenBefore).some((u) => /[?&]begin=(?!0\b)\d+/.test(u)), {
      timeout: 60_000,
    })
    .toBe(true);
  await expect
    .poll(async () => paintedCount(await cardTexts(page)), { timeout: 60_000 })
    .toBeGreaterThan(5);
});

test("both themes paint and the choice survives a reload", async ({ page }) => {
  // Headless Chromium prefers light, and with no stored choice the app follows
  // the OS, so a fresh page is light.
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  const lightBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);

  // A stored choice wins over the OS preference, and a reload keeps it. No init
  // script here: it would run again on the reload and overwrite the choice.
  await page.evaluate(() => localStorage.setItem("dftracer:theme", "dark"));
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  const darkBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(darkBg).not.toBe(lightBg);

  await expect(page.locator("nav.leftnav")).toBeVisible();
  await expect(page.locator(".runs-bar")).toBeVisible();
});

test("the entry bundle stays small and the heavy view loads on demand", async ({ page }) => {
  await boot(page, "dark");
  await expect(page.locator(".runs-bar")).toBeVisible();
  await page.waitForTimeout(1500);

  // Boot must not pay for cytoscape or the Arrow decoder. The entry chunk is
  // ~69 KB gzipped when both are split out and ~278 KB when they are not, so a
  // transfer above 120 KB means one of them got merged back into the entry.
  const entry = await page.evaluate(() =>
    performance
      .getEntriesByType("resource")
      .filter((e) => /\.js$/.test(e.name) && /\/assets\/index-/.test(e.name))
      .map((e) => (e as PerformanceResourceTiming).transferSize),
  );
  expect(entry.length).toBe(1);
  expect(entry[0]).toBeLessThan(120_000);

  // Opening the view loads its chunk and it draws.
  // The synthetic trace has no provenance records, so the view shows its empty
  // state; what matters here is that the chunk arrived and the view mounted.
  await page.locator('nav.leftnav a[href*="view=provenance"]').first().click();
  await expect(page.locator(".prov")).toBeVisible({ timeout: 30_000 });
  const chunks = await page.evaluate(() =>
    performance.getEntriesByType("resource").map((e) => e.name.split("/").pop() ?? ""),
  );
  expect(chunks.some((n) => n.startsWith("ProvenanceView-"))).toBe(true);
});
