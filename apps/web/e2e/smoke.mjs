/**
 * Phase 11F browser smoke for the real local development topology.
 *
 * Prerequisites: PostgreSQL running, migrated, seeded, permissions synced,
 * API on :4000, and Web on :5173. This remains manual/CI-optional and is not
 * part of the API integration-test count.
 *
 * Usage: npm run e2e -w apps/web
 */
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import playwright from "playwright";

const { chromium } = playwright;
const BASE = (process.env.E2E_BASE_URL ?? "http://localhost:5173").replace(/\/$/, "");
const SCREENSHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? join(tmpdir(), "abixell-one-e2e-screenshots");
mkdirSync(SCREENSHOT_DIR, { recursive: true });

const launchOptions = process.env.PLAYWRIGHT_CHROMIUM_PATH
  ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH }
  : {};
const browser = await chromium.launch(launchOptions);
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();
const unexpectedDiagnostics = [];
const expectedHttpFailures = [];
let step = 0;

function expectHttpFailure(pathname, status) {
  expectedHttpFailures.push({ pathname, status });
}

page.on("console", (message) => {
  if (
    message.type() === "error" &&
    !message.text().startsWith("Failed to load resource: the server responded with a status of")
  ) {
    unexpectedDiagnostics.push(`console: ${message.text()}`);
  }
});
page.on("pageerror", (error) => {
  unexpectedDiagnostics.push(`pageerror: ${error.message}`);
});
page.on("requestfailed", (request) => {
  unexpectedDiagnostics.push(
    `requestfailed: ${request.method()} ${request.url()} (${request.failure()?.errorText ?? "unknown"})`,
  );
});
page.on("response", (response) => {
  if (response.status() < 400) return;
  const pathname = new URL(response.url()).pathname;
  const expectedIndex = expectedHttpFailures.findIndex(
    (expected) => expected.pathname === pathname && expected.status === response.status(),
  );
  if (expectedIndex >= 0) {
    expectedHttpFailures.splice(expectedIndex, 1);
    return;
  }
  unexpectedDiagnostics.push(`HTTP ${response.status()} ${response.url()}`);
});

async function shot(name) {
  step += 1;
  await page.screenshot({
    path: join(SCREENSHOT_DIR, `${String(step).padStart(2, "0")}-${name}.png`),
    fullPage: true,
  });
}

async function assertVisible(locator, message) {
  await locator.waitFor({ state: "visible", timeout: 8000 });
  assert.equal(await locator.isVisible(), true, message);
}

async function assertNoHorizontalOverflow(label) {
  const noOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth + 1,
  );
  assert.equal(noOverflow, true, `${label} has page-level horizontal overflow`);
}

async function assertMinimumTouchTarget(locator, label, minimum = 44) {
  const box = await locator.boundingBox();
  assert.ok(box, `${label} has no bounding box`);
  assert.ok(box.width >= minimum, `${label} is only ${box.width}px wide`);
  assert.ok(box.height >= minimum, `${label} is only ${box.height}px high`);
}

async function assertDialogFocusContained(dialog, label) {
  await page.keyboard.press("Tab");
  assert.equal(
    await dialog.evaluate((element) => element.contains(document.activeElement)),
    true,
    `${label} allowed focus to escape`,
  );
}

async function closeDialogWithBackdrop(dialog) {
  const backdrop = dialog.locator("xpath=..");
  const box = await backdrop.boundingBox();
  assert.ok(box, "Dialog backdrop has no bounding box");
  await page.mouse.click(box.x + 2, box.y + 2);
  await dialog.waitFor({ state: "detached" });
  // OverlayDialog restores focus from its effect cleanup after the portal
  // detaches; yield one frame before asserting the destination.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve())));
}

async function currentAccessToken() {
  return page.evaluate(() => {
    const raw = window.localStorage.getItem("abixell.session");
    return raw ? JSON.parse(raw).accessToken : null;
  });
}

async function restoreTemporaryAssignment(userId, assignmentId) {
  const token = await currentAccessToken();
  if (!token) return;
  const response = await page.request.delete(
    `${BASE}/api/admin/users/${encodeURIComponent(userId)}/role-assignments/${encodeURIComponent(assignmentId)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (response.status() !== 204 && response.status() !== 404) {
    throw new Error(`Temporary role assignment cleanup failed (${response.status()})`);
  }
}

let temporaryAssignment = null;

try {
  console.log("1. Authentication and persisted session");
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  await page.waitForURL(/\/login/, { timeout: 5000 });
  await shot("login-page");

  const emailInput = page.getByLabel("Email");
  const passwordInput = page.getByLabel("Password");
  await emailInput.fill("admin@demo.local");
  await passwordInput.fill("admin123!");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(`${BASE}/select-workspace`, { timeout: 8000 });
  await assertVisible(
    page.getByRole("heading", { name: "Choose how you want to work", exact: true }),
    "Role and site selection did not render",
  );
  await assertVisible(page.getByLabel("Role"), "Role selection is missing");
  await assertVisible(page.getByLabel("Site"), "Site selection is missing");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.waitForURL(`${BASE}/`, { timeout: 8000 });
  await assertVisible(page.getByRole("heading", { name: /Welcome to/i }), "Overview did not render");
  assert.ok(await page.evaluate(() => window.localStorage.getItem("abixell.session")), "Session was not persisted");

  await page.reload({ waitUntil: "networkidle" });
  assert.equal(page.url(), `${BASE}/`, "Persisted session returned to login after reload");
  await assertVisible(page.getByRole("heading", { name: /Welcome to/i }), "Overview did not restore");
  await shot("overview-desktop");

  console.log("2. Grouped desktop shell and capability-gated destinations");
  const desktopNav = page.locator("aside").filter({ has: page.locator("#desktop-navigation-filter") });
  for (const group of ["Operations", "Enterprise Core", "Governance & Platform"]) {
    await assertVisible(desktopNav.getByRole("heading", { name: group, exact: true }), `Missing ${group} group`);
  }
  for (const destination of ["Overview", "Administration", "Admin Console"]) {
    await assertVisible(
      desktopNav.getByRole("link", { name: destination, exact: true }),
      `Missing ${destination} navigation link`,
    );
  }
  assert.equal(
    await page.getByRole("button", { name: "Open navigation" }).isVisible(),
    false,
    "Desktop should use the persistent sidebar",
  );

  const hseDisclosure = desktopNav.getByRole("button", { name: /Health, Safety & Environment/i });
  await assertVisible(hseDisclosure, "Missing HSE module disclosure button");
  assert.equal(await hseDisclosure.getAttribute("aria-expanded"), "false", "HSE module should be collapsed by default");
  await hseDisclosure.click();
  assert.equal(await hseDisclosure.getAttribute("aria-expanded"), "true", "HSE module did not expand after click");
  await assertVisible(
    desktopNav.getByRole("link", { name: "HSE", exact: true }),
    "Missing HSE navigation link after expanding module",
  );

  await desktopNav.getByLabel("Filter navigation").fill("Admin Console");
  await assertVisible(
    desktopNav.getByRole("link", { name: "Admin Console", exact: true }),
    "Visible navigation filtering lost Admin Console",
  );
  assert.equal(
    await desktopNav.getByRole("link", { name: "HSE", exact: true }).isVisible(),
    false,
    "Navigation filter did not hide non-matching destinations",
  );
  await desktopNav.getByRole("button", { name: "Clear navigation filter" }).click();

  console.log("3. Live Admin Console overview and durable section navigation");
  await desktopNav.getByRole("link", { name: "Admin Console", exact: true }).click();
  await page.waitForURL(`${BASE}/admin`, { timeout: 8000 });
  await assertVisible(page.getByRole("heading", { name: "Admin Console", exact: true }), "Admin Console missing");
  assert.equal(
    await page.getByText("Read only", { exact: true }).count(),
    0,
    "Governed access manager was incorrectly reported as read only",
  );
  await assertVisible(
    page.getByRole("heading", { name: "Governed user access management", exact: true }),
    "Governed access capability summary missing",
  );
  await assertVisible(page.getByRole("link", { name: "Open Users" }), "Users summary card is not navigable");
  await assertVisible(page.getByRole("link", { name: "Open Roles" }), "Roles summary card is not navigable");
  await shot("admin-overview");

  await page.getByRole("link", { name: "Open Roles" }).click();
  await page.waitForURL(`${BASE}/admin?section=roles`);
  await assertVisible(page.getByRole("heading", { name: "Roles", exact: true }), "Roles section missing");

  const adminRoleCardOrRow = page.locator("tr", { has: page.getByText("ADMIN", { exact: true }) });
  const roleDetailTrigger = adminRoleCardOrRow.getByRole("button", { name: "View permissions" });
  await roleDetailTrigger.click();
  const roleDetailDialog = page.getByRole("dialog", { name: "Administrator permissions" });
  await assertVisible(roleDetailDialog, "On-demand role permission dialog missing");
  await assertVisible(
    roleDetailDialog.getByText("user.role.manage", { exact: true }),
    "On-demand role permission detail omitted user.role.manage",
  );
  assert.equal(
    await roleDetailDialog.getByText("admin@demo.local", { exact: true }).count(),
    0,
    "Role permission detail leaked user identity data",
  );
  await assertDialogFocusContained(roleDetailDialog, "Role permission dialog");
  await assertMinimumTouchTarget(
    roleDetailDialog.getByRole("button", { name: "Close dialog" }),
    "Role permission close",
  );
  await page.keyboard.press("Escape");
  await roleDetailDialog.waitFor({ state: "detached" });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve())));
  assert.equal(
    await roleDetailTrigger.evaluate((element) => element === document.activeElement),
    true,
    "Role permission dialog did not restore focus after Escape",
  );

  await roleDetailTrigger.click();
  const backdropRoleDialog = page.getByRole("dialog", { name: "Administrator permissions" });
  await assertVisible(backdropRoleDialog, "Role permission dialog did not reopen");
  await closeDialogWithBackdrop(backdropRoleDialog);
  assert.equal(
    await roleDetailTrigger.evaluate((element) => element === document.activeElement),
    true,
    "Role permission dialog did not restore focus after backdrop close",
  );

  const sectionNav = page.getByRole("navigation", { name: "Admin Console sections" });
  await sectionNav.getByRole("link", { name: "Permissions", exact: true }).click();
  await page.waitForURL(`${BASE}/admin?section=permissions`);
  await assertVisible(
    page.getByRole("heading", { name: "Permissions", exact: true }),
    "Permissions section missing",
  );
  await page.goBack({ waitUntil: "networkidle" });
  await page.waitForURL(`${BASE}/admin?section=roles`);
  await page.goForward({ waitUntil: "networkidle" });
  await page.waitForURL(`${BASE}/admin?section=permissions`);

  const permissionFilter = page.getByLabel("Filter permissions");
  await permissionFilter.fill("admin.console.read");
  await assertVisible(page.getByText(/Showing \d+ of \d+/), "Permission result count missing");
  await assertVisible(page.getByRole("button", { name: "Clear filters" }), "Clear Filters action missing");
  await page.getByRole("button", { name: "Clear filters" }).click();
  assert.equal(await permissionFilter.inputValue(), "", "Clear Filters did not reset the query");

  const liveSections = [
    ["Modules", "modules", "Modules"],
    ["Workflows", "workflows", "Workflow definitions"],
    ["Recent activity", "audit", "Recent activity"],
  ];
  for (const [label, key, heading] of liveSections) {
    await sectionNav.getByRole("link", { name: label, exact: true }).click();
    await page.waitForURL(`${BASE}/admin?section=${key}`);
    await assertVisible(page.getByRole("heading", { name: heading, exact: true }), `${label} section missing`);
  }
  await page.reload({ waitUntil: "networkidle" });
  assert.equal(page.url(), `${BASE}/admin?section=audit`, "Section query did not survive reload");
  await assertVisible(page.getByRole("heading", { name: "Recent activity", exact: true }), "Reload lost active section");

  await page.goto(`${BASE}/admin?section=unknown`, { waitUntil: "networkidle" });
  await assertVisible(
    page.getByRole("heading", { name: "Governed user access management", exact: true }),
    "Unknown section did not fall back to Overview",
  );
  assert.equal(
    await sectionNav.getByRole("link", { name: "Overview", exact: true }).getAttribute("aria-current"),
    "page",
    "Unknown section did not mark Overview current",
  );

  console.log("4. Governed Users access inspection and reversible role assignment");
  await sectionNav.getByRole("link", { name: "Users", exact: true }).click();
  await page.waitForURL(`${BASE}/admin?section=users`);
  await assertVisible(page.getByRole("heading", { name: "Users and access", exact: true }), "Users section missing");
  await assertVisible(
    page.locator("table").getByText("reviewer@demo.local", { exact: true }),
    "Privacy-minimized user summary missing",
  );
  await assertVisible(page.getByText(/Showing \d+ of \d+/), "User result count missing");
  const userSearch = page.getByLabel("Search users by name, email, status, or role");
  await userSearch.fill("reviewer@demo.local");
  await assertVisible(page.getByText("Showing 1 of", { exact: false }), "User search did not narrow the result");

  const reviewerRow = page.locator("tr", { has: page.getByText("reviewer@demo.local", { exact: true }) });
  const manageAccess = reviewerRow.getByRole("button", { name: "Assign access" });
  await assertMinimumTouchTarget(manageAccess, "Desktop Manage access", 36);

  let assignmentPostCount = 0;
  let observedAssignmentRequest;
  const assignmentRequestObserved = new Promise((resolve) => {
    observedAssignmentRequest = resolve;
  });
  const delayAssignment = async (route) => {
    assignmentPostCount += 1;
    observedAssignmentRequest();
    await new Promise((resolve) => setTimeout(resolve, 300));
    await route.continue();
  };

  await manageAccess.click();
  let accessDialog = page.getByRole("dialog", { name: "Assign access · Demo Workflow Reviewer" });
  await assertVisible(accessDialog, "Governed access dialog missing");
  await page.waitForFunction(
    () => document.activeElement?.getAttribute("aria-label") === "Close dialog",
  );
  await assertDialogFocusContained(accessDialog, "Governed access dialog");
  await assertMinimumTouchTarget(accessDialog.getByRole("button", { name: "Close dialog" }), "Access dialog close");
  await page.keyboard.press("Escape");
  await accessDialog.waitFor({ state: "detached" });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve())));
  assert.equal(
    await manageAccess.evaluate((element) => element === document.activeElement),
    true,
    "Access dialog did not restore focus after Escape",
  );

  await manageAccess.click();
  accessDialog = page.getByRole("dialog", { name: "Assign access · Demo Workflow Reviewer" });
  await assertVisible(accessDialog, "Access dialog did not reopen");
  await closeDialogWithBackdrop(accessDialog);
  assert.equal(
    await manageAccess.evaluate((element) => element === document.activeElement),
    true,
    "Access dialog did not restore focus after backdrop close",
  );

  await manageAccess.click();
  accessDialog = page.getByRole("dialog", { name: "Assign access · Demo Workflow Reviewer" });
  await assertVisible(accessDialog, "Access dialog did not reopen for assignment");
  await accessDialog.getByRole("button", { name: "Add assignment" }).click();
  const roleSelect = accessDialog.getByLabel("Role 1");
  const scopeSelect = accessDialog.getByLabel("Scope 1");
  // Roles the user already holds are disabled in the picker (duplicate
  // prevention), so the first enabled option is already unassigned.
  const availableRole = await roleSelect
    .locator("option:not([disabled])")
    .first()
    .getAttribute("value");
  assert.ok(availableRole, "No unassigned selectable role available for smoke mutation");
  await roleSelect.selectOption(availableRole);
  await scopeSelect.selectOption("tenant");
  const selectedRoleCode = availableRole;
  // Option text renders as "{name} ({code})"; the revoke dialog later shows
  // only the bare name.
  const selectedRoleName = (await roleSelect.locator("option:checked").innerText())
    .replace(/\s*\([^)]*\)\s*$/, "")
    .trim();
  await accessDialog.getByRole("button", { name: "Review batch" }).click();
  await assertVisible(accessDialog.getByRole("heading", { name: "What will be granted" }), "Change review is not mandatory");
  await assertVisible(accessDialog.getByText(selectedRoleCode, { exact: true }), "Target role code missing");
  await assertVisible(accessDialog.getByText("This hash binds the confirmation", { exact: false }), "Preview integrity note missing");

  const addPath = /\/api\/admin\/users\/([^/]+)\/assignment-batches$/;
  await page.route(addPath, delayAssignment);
  let assignmentTargetUserId = null;
  const addResponsePromise = page.waitForResponse((response) => {
    if (response.request().method() !== "POST") return false;
    const match = new URL(response.url()).pathname.match(addPath);
    if (!match) return false;
    assignmentTargetUserId = decodeURIComponent(match[1]);
    return true;
  });
  const confirmAdd = accessDialog.getByRole("button", { name: "Confirm 1 assignment" });
  await confirmAdd.click();
  await assignmentRequestObserved;
  await assertVisible(accessDialog.getByText("Applying batch…", { exact: true }), "Pending mutation state missing");
  assert.equal(await confirmAdd.count(), 0, "Pending state retained a second enabled confirm control");
  assert.equal(
    await accessDialog.getAttribute("aria-busy"),
    "true",
    "Pending access dialog did not expose aria-busy",
  );
  assert.equal(
    await accessDialog.getByRole("button", { name: "Close dialog" }).isDisabled(),
    true,
    "Pending access dialog close control stayed enabled",
  );
  await page.keyboard.press("Escape");
  assert.equal(await accessDialog.isVisible(), true, "Escape dismissed a pending access mutation");
  const pendingBackdrop = accessDialog.locator("xpath=..");
  const pendingBackdropBox = await pendingBackdrop.boundingBox();
  assert.ok(pendingBackdropBox, "Pending dialog backdrop has no bounding box");
  await page.mouse.click(pendingBackdropBox.x + 2, pendingBackdropBox.y + 2);
  assert.equal(await accessDialog.isVisible(), true, "Backdrop dismissed a pending access mutation");
  await page.keyboard.press("Enter");
  assert.equal(assignmentPostCount, 1, "Pending interaction submitted the mutation more than once");
  const addResponse = await addResponsePromise;
  assert.equal(addResponse.status(), 201, "Governed assignment POST did not return 201");
  const createdAssignment = await addResponse.json();
  temporaryAssignment = {
    userId: assignmentTargetUserId,
    assignmentId: createdAssignment.id,
  };
  assert.ok(temporaryAssignment.userId, "Temporary assignment cleanup could not resolve target user");
  await accessDialog.waitFor({ state: "detached", timeout: 8000 });
  await page.unroute(addPath, delayAssignment);
  await assertVisible(
    page.getByText("1 assignment added for Demo Workflow Reviewer.", { exact: true }),
    "Authoritative add success feedback missing",
  );
  // The table's role badge list is capped to the first 3 assignments and
  // carries no lifecycle state, so it cannot reliably prove the new grant
  // landed; the detail dialog below lists every assignment unfiltered and is
  // the authoritative check instead.
  const updatedReviewerRow = page.locator("tr", { has: page.getByText("reviewer@demo.local", { exact: true }) });
  const updatedManageAccess = updatedReviewerRow.getByRole("button", { name: "View access" }).first();
  await updatedManageAccess.click();
  const detailDialog = page.getByRole("dialog", { name: "Access · Demo Workflow Reviewer" });
  await assertVisible(detailDialog, "User access detail dialog did not open");
  // The detail list shows lifecycle state per row (StatusPill "Active" vs
  // "Revoked"), so scope to the row that is both this role and still active.
  const newAssignmentRow = detailDialog
    .locator("li", { hasText: selectedRoleCode })
    .filter({ hasText: "Active" });
  await assertVisible(newAssignmentRow, "Newly granted assignment not found in active state");
  await newAssignmentRow.getByRole("button", { name: "Review revocation" }).click();
  const revokeDialog = page.getByRole("dialog", { name: "Review revocation" });
  await assertVisible(revokeDialog, "Revocation review dialog did not open");
  await assertVisible(revokeDialog.getByText(selectedRoleName, { exact: false }), "Revoke role name summary missing");
  await revokeDialog.getByLabel("Reason").fill("Smoke test cleanup");
  await revokeDialog.getByRole("button", { name: "Confirm revoke" }).click();
  await revokeDialog.waitFor({ state: "detached", timeout: 8000 });
  await detailDialog.getByRole("button", { name: "Close dialog" }).click();
  temporaryAssignment = null;
  await assertVisible(
    page.getByText(/^Revoked .+ access from Demo Workflow Reviewer\.$/),
    "Authoritative removal success feedback missing",
  );
  // Revocation retains the historical row (§4.4 Wave 3), so the table badge
  // list — which shows every assignment regardless of lifecycle state — is
  // not a reliable "gone" signal. Re-open the detail dialog instead, where
  // each row's StatusPill proves the authoritative current state.
  const restoredReviewerRow = page.locator("tr", { has: page.getByText("reviewer@demo.local", { exact: true }) });
  await restoredReviewerRow.getByRole("button", { name: "View access" }).first().click();
  const restoredDetailDialog = page.getByRole("dialog", { name: "Access · Demo Workflow Reviewer" });
  await assertVisible(restoredDetailDialog, "User access detail dialog did not reopen");
  const restoredAssignmentRow = restoredDetailDialog
    .locator("li", { hasText: selectedRoleCode })
    .filter({ hasText: "Active" });
  assert.equal(
    await restoredAssignmentRow.count(),
    0,
    "Reversible smoke left the temporary assignment active",
  );
  await restoredDetailDialog.getByRole("button", { name: "Close dialog" }).click();
  await shot("admin-users-governed-access");

  console.log("5. Responsive drawer, Users layouts, touch targets, and overflow");
  for (const viewport of [
    { name: "desktop", width: 1280, height: 800 },
    { name: "tablet", width: 768, height: 1024 },
    { name: "mobile", width: 390, height: 844 },
  ]) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await assertNoHorizontalOverflow(viewport.name);
    await assertVisible(page.getByRole("heading", { name: "Users and access", exact: true }), `${viewport.name} Users view missing`);
    const responsiveManage = page.getByRole("button", { name: "View access" }).first();
    await assertVisible(responsiveManage, `${viewport.name} View access missing`);
    await assertMinimumTouchTarget(
      responsiveManage,
      `${viewport.name} View access`,
      viewport.width < 640 ? 44 : 36,
    );
    if (viewport.width < 768) {
      assert.equal(
        await page.locator("table").filter({ hasText: "reviewer@demo.local" }).isVisible(),
        false,
        `${viewport.name} should use user cards instead of the desktop table`,
      );
    } else {
      await assertVisible(
        page.locator("table").filter({ hasText: "reviewer@demo.local" }),
        `${viewport.name} desktop user table missing`,
      );
    }
    if (viewport.width < 1024) {
      const menu = page.getByRole("button", { name: "Open navigation" });
      await assertVisible(menu, `${viewport.name} menu trigger missing`);
      await assertMinimumTouchTarget(menu, `${viewport.name} menu trigger`);
      await menu.click();
      const drawer = page.getByRole("dialog", { name: /.+/ });
      await assertVisible(drawer, `${viewport.name} drawer did not open`);
      await page.waitForFunction(
        () => document.activeElement?.getAttribute("aria-label") === "Close navigation",
      );
      assert.equal(
        await page.evaluate(() => document.activeElement?.getAttribute("aria-label")),
        "Close navigation",
        `${viewport.name} drawer did not receive focus`,
      );
      await assertMinimumTouchTarget(
        drawer.getByRole("link", { name: "Overview", exact: true }),
        `${viewport.name} navigation link`,
      );

      const drawerFilter = drawer.getByLabel("Filter navigation");
      await drawerFilter.fill("no matching destination");
      await drawer.getByRole("button", { name: "Clear filter", exact: true }).click();
      assert.equal(
        await drawerFilter.evaluate((element) => element === document.activeElement),
        true,
        `${viewport.name} clear filter did not return focus to the filter input`,
      );
      await page.keyboard.press("Tab");
      assert.equal(
        await drawer.evaluate((element) => element.contains(document.activeElement)),
        true,
        `${viewport.name} focus escaped the open navigation drawer`,
      );

      await page.keyboard.press("Escape");
      await drawer.waitFor({ state: "detached" });
      assert.equal(
        await menu.evaluate((element) => element === document.activeElement),
        true,
        `${viewport.name} drawer did not restore focus to its trigger`,
      );
      await assertNoHorizontalOverflow(`${viewport.name} after drawer close`);

      if (viewport.name === "tablet") {
        await menu.click();
        const breakpointDrawer = page.getByRole("dialog", { name: /.+/ });
        await assertVisible(breakpointDrawer, "Tablet drawer did not reopen");
        await page.setViewportSize({ width: 1280, height: 800 });
        await breakpointDrawer.waitFor({ state: "detached" });
        await page.waitForFunction(() => document.body.style.overflow !== "hidden");
        assert.notEqual(
          await page.evaluate(() => document.body.style.overflow),
          "hidden",
          "Crossing the desktop breakpoint left body scrolling locked",
        );
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await assertVisible(menu, "Tablet menu trigger did not return after breakpoint check");
      }
    }
  }
  await shot("admin-mobile");
  await page.setViewportSize({ width: 1280, height: 800 });

  console.log("6. Tenant-safe unavailable assignment projection");
  const unavailableAssignmentId = "00000000-0000-4000-8000-00000000011f";
  const unavailableScopeId = "00000000-0000-4000-8000-000000000120";
  const unavailableScopeUserId = "00000000-0000-4000-8000-000000000121";
  const forbiddenScopeName = "Foreign Tenant Executive Office";
  function unavailableScopeAccessBody() {
    return {
      id: unavailableScopeUserId,
      fullName: "Unavailable Scope Reviewer",
      email: "unavailable.scope@example.invalid",
      status: "active",
      roleAssignments: [
        {
          id: unavailableAssignmentId,
          roleState: "available",
          roleCode: "SUPERVISOR",
          roleName: "Site Supervisor",
          scopeType: "organization_unit",
          scopeState: "unavailable",
          scopeOrganizationUnitId: unavailableScopeId,
          scopeOrganizationUnitName: forbiddenScopeName,
          scopeCustomerId: null,
          scopeCustomerName: null,
          assignmentState: "active",
          revokedAt: null,
          revokedBy: null,
          revokeReason: null,
        },
      ],
    };
  }
  const unavailableUsers = async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([unavailableScopeAccessBody()]),
    });
  };
  const unavailableScopeAccess = async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(unavailableScopeAccessBody()),
    });
  };
  await page.route("**/api/admin/users", unavailableUsers);
  await page.route(`**/api/admin/users/${unavailableScopeUserId}/access`, unavailableScopeAccess);
  await page.goto(`${BASE}/admin?section=users`, { waitUntil: "networkidle" });
  const unavailableRow = page.locator("tr", {
    has: page.getByText("unavailable.scope@example.invalid", { exact: true }),
  });
  await assertVisible(
    unavailableRow.getByText("Unavailable organization unit", { exact: false }),
    "Desktop unavailable Organization Unit label missing",
  );
  assert.equal(
    await page.getByText(forbiddenScopeName, { exact: true }).count(),
    0,
    "Unavailable assignment rendered server-supplied scope metadata",
  );
  await unavailableRow.getByRole("button", { name: "View access" }).click();
  let unavailableDialog = page.getByRole("dialog", {
    name: "Access · Unavailable Scope Reviewer",
  });
  await assertVisible(
    unavailableDialog.getByText("Unavailable organization unit", { exact: false }),
    "Unavailable status missing from current-access dialog",
  );
  await unavailableDialog.getByRole("button", { name: "Review revocation" }).click();
  const unavailableRevokeDialog = page.getByRole("dialog", { name: "Review revocation" });
  await assertVisible(
    unavailableRevokeDialog.getByText("Unavailable organization unit", { exact: false }),
    "Revocation review omitted the generic unavailable state",
  );
  const unavailableAssignmentIdValue = unavailableRevokeDialog
    .locator("dt", { hasText: "Assignment ID" })
    .locator("xpath=following-sibling::dd[1]");
  await assertVisible(
    unavailableAssignmentIdValue,
    "Unavailable revocation review omitted the assignment ID",
  );
  assert.equal(
    await unavailableAssignmentIdValue.innerText(),
    unavailableAssignmentId,
    "Unavailable revocation review displayed the wrong assignment ID",
  );
  assert.equal(
    await unavailableRevokeDialog.getByText(forbiddenScopeName, { exact: true }).count(),
    0,
    "Unavailable revocation review leaked server-supplied scope metadata",
  );
  await page.keyboard.press("Escape");
  await unavailableRevokeDialog.waitFor({ state: "detached" });
  await page.keyboard.press("Escape");
  await unavailableDialog.waitFor({ state: "detached" });

  await page.setViewportSize({ width: 390, height: 844 });
  const unavailableCard = page.locator("li", {
    has: page.getByText("unavailable.scope@example.invalid", { exact: true }),
  });
  await assertVisible(
    unavailableCard.getByText("unavailable.scope@example.invalid", { exact: true }),
    "Mobile unavailable assignment card missing",
  );
  await assertVisible(
    unavailableCard.getByText("Unavailable organization unit", { exact: false }),
    "Mobile unavailable scope status missing",
  );
  assert.equal(
    await unavailableCard.getByText(forbiddenScopeName, { exact: true }).count(),
    0,
    "Mobile unavailable assignment leaked server-supplied scope metadata",
  );
  await assertNoHorizontalOverflow("mobile unavailable assignment");
  await page.unroute(`**/api/admin/users/${unavailableScopeUserId}/access`, unavailableScopeAccess);
  await page.unroute("**/api/admin/users", unavailableUsers);
  await page.setViewportSize({ width: 1280, height: 800 });

  console.log("7. Tenant-safe unavailable Role revocation");
  const unavailableRoleAssignmentId = "00000000-0000-4000-8000-000000000122";
  const unavailableRoleUserId = "00000000-0000-4000-8000-000000000123";
  const forbiddenRoleCode = "FOREIGN_EXECUTIVE_ADMIN";
  const forbiddenRoleName = "Foreign Executive Administrator";
  let unavailableRoleRevoked = false;
  let unavailableRolePermissionRequests = 0;
  let unavailableRoleRevokeRequests = 0;
  function unavailableRoleAccessBody() {
    return {
      id: unavailableRoleUserId,
      fullName: "Unavailable Role Reviewer",
      email: "unavailable.role@example.invalid",
      status: "active",
      roleAssignments: [
        {
          id: unavailableRoleAssignmentId,
          roleState: "unavailable",
          roleCode: null,
          roleName: null,
          scopeType: "organization_unit",
          scopeState: "unavailable",
          scopeOrganizationUnitId: unavailableScopeId,
          scopeOrganizationUnitName: null,
          scopeCustomerId: null,
          scopeCustomerName: null,
          assignmentState: unavailableRoleRevoked ? "revoked" : "active",
          revokedAt: unavailableRoleRevoked ? new Date().toISOString() : null,
          revokedBy: null,
          revokeReason: unavailableRoleRevoked ? "Smoke test cleanup" : null,
        },
      ],
    };
  }
  const unavailableRoleUsers = async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([unavailableRoleAccessBody()]),
    });
  };
  const unavailableRoleAccess = async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(unavailableRoleAccessBody()),
    });
  };
  const unavailableRolePermissions = async (route) => {
    unavailableRolePermissionRequests += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        roleCode: forbiddenRoleCode,
        roleName: forbiddenRoleName,
        isFullAccess: false,
        permissions: [],
      }),
    });
  };
  const unavailableRoleRevokePath =
    `/api/admin/users/${unavailableRoleUserId}/role-assignments/${unavailableRoleAssignmentId}/revoke`;
  const unavailableRoleRevoke = async (route) => {
    assert.equal(route.request().method(), "POST", "Unavailable Role mutation used the wrong method");
    assert.equal(
      new URL(route.request().url()).pathname,
      unavailableRoleRevokePath,
      "Unavailable Role mutation targeted the wrong assignment",
    );
    unavailableRoleRevokeRequests += 1;
    unavailableRoleRevoked = true;
    await route.fulfill({ status: 204, body: "" });
  };
  await page.route("**/api/admin/users", unavailableRoleUsers);
  await page.route(`**/api/admin/users/${unavailableRoleUserId}/access`, unavailableRoleAccess);
  await page.route("**/api/admin/roles/*/permissions", unavailableRolePermissions);
  await page.route(`**${unavailableRoleRevokePath}`, unavailableRoleRevoke);
  await page.goto(`${BASE}/admin?section=users`, { waitUntil: "networkidle" });
  const unavailableRoleRow = page.locator("tr", {
    has: page.getByText("unavailable.role@example.invalid", { exact: true }),
  });
  await assertVisible(
    unavailableRoleRow.getByText("Unavailable role", { exact: false }).first(),
    "Desktop unavailable Role label missing",
  );
  assert.equal(
    await page.getByText(forbiddenRoleCode, { exact: true }).count(),
    0,
    "Unavailable Role projection leaked a foreign role code",
  );
  assert.equal(
    await page.getByText(forbiddenRoleName, { exact: true }).count(),
    0,
    "Unavailable Role projection leaked a foreign role name",
  );
  await unavailableRoleRow.getByRole("button", { name: "View access" }).click();
  const unavailableRoleDialog = page.getByRole("dialog", {
    name: "Access · Unavailable Role Reviewer",
  });
  const unavailableRoleItem = unavailableRoleDialog
    .getByText("Unavailable role", { exact: true })
    .first()
    .locator("xpath=ancestor::li[1]");
  await unavailableRoleItem.getByRole("button", { name: "Review revocation" }).click();
  const unavailableRoleRevokeDialog = page.getByRole("dialog", { name: "Review revocation" });
  await assertVisible(
    unavailableRoleRevokeDialog.getByText("Unavailable role", { exact: true }),
    "Unavailable Role review did not use the generic revocation path",
  );
  const unavailableRoleAssignmentIdValue = unavailableRoleRevokeDialog
    .locator("dt", { hasText: "Assignment ID" })
    .locator("xpath=following-sibling::dd[1]");
  await assertVisible(
    unavailableRoleAssignmentIdValue,
    "Unavailable Role review omitted the assignment ID",
  );
  assert.equal(
    await unavailableRoleAssignmentIdValue.innerText(),
    unavailableRoleAssignmentId,
    "Unavailable Role review displayed the wrong assignment ID",
  );
  await page.waitForTimeout(50);
  assert.equal(
    unavailableRolePermissionRequests,
    0,
    "Unavailable Role revocation requested role permission metadata",
  );
  assert.equal(
    await unavailableRoleRevokeDialog.getByText(forbiddenRoleCode, { exact: true }).count(),
    0,
    "Unavailable Role revocation leaked a foreign role code",
  );
  assert.equal(
    await unavailableRoleRevokeDialog.getByText(forbiddenRoleName, { exact: true }).count(),
    0,
    "Unavailable Role revocation leaked a foreign role name",
  );
  await unavailableRoleRevokeDialog.getByLabel("Reason").fill("Smoke test cleanup");
  await unavailableRoleRevokeDialog.getByRole("button", { name: "Confirm revoke" }).click();
  await unavailableRoleRevokeDialog.waitFor({ state: "detached", timeout: 8000 });
  assert.equal(
    unavailableRoleRevokeRequests,
    1,
    "Unavailable Role revocation did not issue exactly one exact POST",
  );
  await assertVisible(
    page.getByText(
      "Revoked Unavailable role access from Unavailable Role Reviewer.",
      { exact: true },
    ),
    "Unavailable Role revocation success feedback was not generic",
  );
  assert.equal(
    await page.getByText(forbiddenRoleCode, { exact: true }).count(),
    0,
    "Unavailable Role flow exposed a foreign role code",
  );
  assert.equal(
    await page.getByText(forbiddenRoleName, { exact: true }).count(),
    0,
    "Unavailable Role flow exposed a foreign role name",
  );
  await page.unroute(`**${unavailableRoleRevokePath}`, unavailableRoleRevoke);
  await page.unroute("**/api/admin/roles/*/permissions", unavailableRolePermissions);
  await page.unroute(`**/api/admin/users/${unavailableRoleUserId}/access`, unavailableRoleAccess);
  await page.unroute("**/api/admin/users", unavailableRoleUsers);

  console.log("8. Intercepted deterministic Admin Console states");
  const rolesDenied = async (route) => {
    expectHttpFailure("/api/admin/roles", 403);
    await route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: "Forbidden" }) });
  };
  await page.route("**/api/admin/roles", rolesDenied);
  await page.goto(`${BASE}/admin?section=roles`, { waitUntil: "networkidle" });
  await assertVisible(page.getByText("You do not have access to this area"), "403 denial state missing");
  await assertVisible(page.getByText("config.read", { exact: true }), "Required permission badge missing");
  await assertVisible(page.getByRole("link", { name: "Back to overview" }), "Denial recovery action missing");
  await page.unroute("**/api/admin/roles", rolesDenied);

  const modulesExpired = async (route) => {
    expectHttpFailure("/api/admin/modules", 401);
    await route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: "Expired" }) });
  };
  await page.route("**/api/admin/modules", modulesExpired);
  await page.goto(`${BASE}/admin?section=modules`, { waitUntil: "networkidle" });
  await assertVisible(page.getByText("Your session has expired"), "401 session-expired state missing");
  await assertVisible(page.getByRole("button", { name: "Sign in again" }), "Session recovery action missing");
  await page.unroute("**/api/admin/modules", modulesExpired);
  await page.goto(`${BASE}/admin`, { waitUntil: "networkidle" });

  let auditAttempts = 0;
  let auditShouldFail = true;
  const auditRetry = async (route) => {
    auditAttempts += 1;
    if (auditShouldFail) {
      // React StrictMode intentionally mounts effects twice in development,
      // so register each observed intercepted failure rather than assuming one.
      expectHttpFailure("/api/admin/audit/recent", 500);
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "Temporary administration failure" }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([
        {
          id: "retry-recovered-event",
          action: "admin.retry.recovered",
          entityType: "admin_console",
          actorUserId: null,
          createdAt: "2026-08-24T00:00:00.000Z",
        },
      ]),
    });
  };
  await page.route("**/api/admin/audit/recent", auditRetry);
  await page.goto(`${BASE}/admin?section=audit`, { waitUntil: "domcontentloaded" });
  await assertVisible(page.getByRole("alert"), "500 error state missing");
  const attemptsBeforeRetry = auditAttempts;
  auditShouldFail = false;
  await page.getByRole("button", { name: "Retry" }).click();
  await assertVisible(
    page.getByRole("cell", { name: "admin.retry.recovered", exact: true }),
    "Retry did not recover",
  );
  assert.equal(auditAttempts, attemptsBeforeRetry + 1, "Retry did not issue one replacement request");
  await page.unroute("**/api/admin/audit/recent", auditRetry);

  const workflowsEmpty = async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
  };
  await page.route("**/api/admin/workflows", workflowsEmpty);
  await page.goto(`${BASE}/admin?section=workflows`, { waitUntil: "networkidle" });
  await assertVisible(page.getByText("No workflow definitions configured"), "Empty workflow state missing");
  await page.unroute("**/api/admin/workflows", workflowsEmpty);

  console.log("9. PWA metadata");
  const manifestHref = await page.getAttribute('link[rel="manifest"]', "href");
  assert.ok(manifestHref, "Manifest link is missing");
  const manifest = await page.evaluate(async (href) => {
    const response = await fetch(href);
    if (!response.ok) throw new Error(`Manifest request failed (${response.status})`);
    return response.json();
  }, manifestHref);
  assert.equal(manifest.name, "Enterprise Management System", "Unexpected PWA manifest name");
  assert.ok(Array.isArray(manifest.icons) && manifest.icons.length >= 2, "PWA icons are incomplete");

  console.log("10. Logout and post-logout protection");
  // Sign out lives inside the avatar dropdown (Epic 2 Wave 1), so the menu
  // has to be opened first. Two triggers exist in the DOM at desktop width
  // (persistent sidebar + header); either opens an equivalent menu, so
  // `.first()` is deterministic.
  await page.locator('button[aria-haspopup="menu"]').first().click();
  const userMenu = page.getByRole("menu", { name: "User menu" });
  await assertVisible(userMenu, "User menu did not open");
  await assertVisible(userMenu.getByRole("menuitem", { name: "Profile" }), "Profile entry missing from user menu");
  await userMenu.getByRole("menuitem", { name: "Sign out" }).click();
  await page.waitForURL(/\/login/, { timeout: 5000 });
  assert.equal(
    await page.evaluate(() => window.localStorage.getItem("abixell.session")),
    null,
    "Logout did not clear persisted session",
  );
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForURL(/\/login/, { timeout: 5000 });
  await shot("after-logout");

  assert.deepEqual(expectedHttpFailures, [], "Not all expected intercepted failures were observed");
  assert.deepEqual(
    unexpectedDiagnostics,
    [],
    `Unexpected browser diagnostics:\n${unexpectedDiagnostics.join("\n")}`,
  );

  console.log(`\nE2E smoke passed. Temporary screenshots: ${SCREENSHOT_DIR}`);
} finally {
  if (temporaryAssignment) {
    try {
      await restoreTemporaryAssignment(
        temporaryAssignment.userId,
        temporaryAssignment.assignmentId,
      );
    } catch (error) {
      console.error(error);
    }
  }
  await context.close();
  await browser.close();
}
