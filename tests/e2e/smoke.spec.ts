// End-to-end smoke: one signed-in journey through the real UI, Worker, queue
// and mock DataForSEO. Serial because each step builds on the previous one.
import { expect, test, type Page } from "@playwright/test";

const run = Date.now().toString(36);
const businessName = `Smoke Coffee ${run}`;
const keyword = "coffee shop";

test.describe.configure({ mode: "serial" });

let page: Page;
let reportUrl = "";
const unexpectedErrors: string[] = [];

/** The app's Field wraps a caption and its input in one div (labels are not associated), so find the input next to the caption. */
const field = (caption: string) => page.getByText(caption, { exact: true }).locator("xpath=..").locator("input, select").first();

test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext();
  // Map tiles are the only external request the UI makes: keep the run offline.
  await context.route(/tile\.openstreetmap\.org|nominatim\.openstreetmap\.org/, (route) => route.abort());
  page = await context.newPage();
  page.on("pageerror", (error) => {
    // Known, harmless: Leaflet finishes a zoom animation after its map was removed on navigation.
    if (/_leaflet_pos/.test(error.message)) return;
    unexpectedErrors.push(error.message);
  });
});

test.afterAll(async () => {
  await page.context().close();
  expect(unexpectedErrors).toEqual([]);
});

test("loads the dashboard", async () => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Rank grids" })).toBeVisible();
});

test("creates a business from a place ID", async () => {
  await page.goto("/businesses");
  await field("Business name").fill(businessName);
  await field("Website domain").fill("smokecoffee.example");
  await field("Google place ID").fill(`ChIJsmoke${run}`);
  await page.getByRole("button", { name: "Add business" }).click();
  await expect(page.getByRole("link", { name: businessName })).toBeVisible();
});

test("creates a tracker and runs a scan to completion", async () => {
  await page.goto("/businesses");
  const row = page.getByRole("row").filter({ hasText: businessName });
  await row.getByRole("button", { name: "New grid" }).click();
  await expect(page.getByRole("heading", { name: "New grid scan" })).toBeVisible();
  await field("Keyword").fill(keyword);
  await page.getByLabel("Grid size").fill("3");
  await field("Queue").selectOption("priority");
  await page.getByRole("button", { name: "Save & run scan" }).click();
  await expect(page).toHaveURL(/\/trackers\/[^/]+$/);
  // The scan runs through the queue; the page polls until it completes.
  await expect(page.getByText(/Scan in progress/)).toBeVisible();
  await expect(page.getByText(/Scan in progress/)).toBeHidden({ timeout: 60_000 });
});

test("renders the heatmap grid and metrics", async () => {
  await expect(page.getByRole("tab", { name: "Latest scan" })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".rank-pin")).toHaveCount(9);
  for (const label of ["ATRP", "ARP", "SoLV", "Found"]) {
    await expect(page.getByText(label, { exact: true }).first()).toBeVisible();
  }
  await expect(page.getByText(/^\d+\/9$/).first()).toBeVisible();
  await expect(page.getByLabel("Rank colour legend")).toBeVisible();
});

test("opens the Alerts page", async () => {
  await page.goto("/alerts");
  await expect(page.getByRole("heading", { name: "Alerts" })).toBeVisible();
});

test("opens the business Profile & reviews panel", async () => {
  await page.goto("/businesses");
  await page.getByRole("row").filter({ hasText: businessName }).getByRole("link", { name: "Profile & reviews" }).click();
  await expect(page.getByRole("heading", { name: businessName })).toBeVisible();
  await expect(page.getByText("Profile & reviews", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("No profile snapshot yet")).toBeVisible();
});

test("creates a public report link and opens it logged out", async ({ browser }) => {
  await page.goto("/");
  await page.getByRole("link", { name: new RegExp(businessName) }).first().click();
  await page.getByRole("tab", { name: "Client report" }).click();
  await field("Label").fill("Smoke report");
  await page.getByRole("button", { name: "Create link" }).click();
  await expect(page.getByText(/Link created/)).toBeVisible();
  reportUrl = await page.locator("input[readonly]").inputValue();
  expect(reportUrl).toMatch(/\/r\/olrep_/);

  // A brand-new context has no cookies: the public page must not need a session.
  const anonymous = await browser.newContext();
  await anonymous.route(/tile\.openstreetmap\.org/, (route) => route.abort());
  const report = await anonymous.newPage();
  await report.goto(reportUrl);
  await expect(report.getByRole("heading", { name: `Local rank report: ${businessName}` })).toBeVisible();
  await expect(report.locator(".rank-pin")).toHaveCount(9);
  await anonymous.close();
});
