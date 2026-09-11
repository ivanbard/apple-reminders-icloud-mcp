import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium, type BrowserContext, type Locator, type Page } from "playwright-core";

const ICLOUD_URL = "https://www.icloud.com/reminders/";
const PROFILE_DIR =
  process.env.ICLOUD_PROFILE_DIR ??
  join(process.env.LOCALAPPDATA ?? homedir(), "apple-reminders-icloud-mcp", "profile");

let context: BrowserContext | undefined;

export type ReminderList = {
  id: string;
  name: string;
  idSource: "icloud" | "derived";
};

export type Reminder = {
  id: string;
  listId: string;
  title: string;
  notes: string | null;
  due: string | null;
  completed: boolean;
};

export type ICloudErrorCode =
  | "AUTH_REQUIRED"
  | "TWO_FACTOR_REQUIRED"
  | "LISTS_UNAVAILABLE"
  | "LIST_NOT_FOUND"
  | "REMINDER_NOT_FOUND"
  | "INVALID_ARGUMENT"
  | "WRITE_FAILED"
  | "PAGE_STRUCTURE_CHANGED";

export class ICloudError extends Error {
  constructor(
    readonly code: ICloudErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ICloudError";
  }
}

export function parseListIdFromReminderRow(rowId: string | null): string | undefined {
  return parseReminderRowId(rowId)?.listId;
}

export function parseReminderRowId(
  rowId: string | null,
): { listId: string; reminderId: string } | undefined {
  const match = rowId?.match(/^reminder-item-(.+) Reminder\/([^/]+)$/);
  return match ? { listId: match[1], reminderId: match[2] } : undefined;
}

export function deriveListId(name: string, occurrence = 0): string {
  const hash = createHash("sha256").update(`${name}\0${occurrence}`).digest("hex").slice(0, 16);
  return `derived:${hash}`;
}

export function normalizeDueText(text: string): string | null {
  return text.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? null;
}

async function isVisible(locator: Locator): Promise<boolean> {
  return locator.isVisible().catch(() => false);
}

export async function findAuthenticatedPage(pages: Page[]): Promise<Page | undefined> {
  for (const page of pages) {
    const tree = page.frameLocator("iframe#early-child").getByRole("tree", { name: "Reminder Lists" });
    if (await isVisible(tree)) return page;
  }
  return undefined;
}

async function getPage(): Promise<Page> {
  context ??= await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: "chrome",
    executablePath: process.env.ICLOUD_BROWSER_PATH,
    headless: true,
  });

  const pages = context.pages();
  const page = pages.find((candidate) => candidate.url().includes("icloud.com/reminders")) ?? pages[0] ?? (await context.newPage());
  if (!page.url().includes("icloud.com/reminders")) {
    await page.goto(ICLOUD_URL, { waitUntil: "domcontentloaded" });
  }
  return page;
}

async function requireReminderTree(page: Page): Promise<Locator> {
  const frame = page.frameLocator("iframe#early-child");
  const tree = frame.getByRole("tree", { name: "Reminder Lists" });

  try {
    await tree.waitFor({ state: "visible", timeout: 3_000 });
    return tree;
  } catch {
    const signIn = page.getByText("Sign In", { exact: true }).first();
    if (await isVisible(signIn)) {
      throw new ICloudError(
        "AUTH_REQUIRED",
        "Run 'npx apple-reminders-icloud-mcp auth' to sign in to iCloud, then retry.",
      );
    }

    const authFrame = page.frameLocator("iframe#aid-auth-widget-iFrame");
    const twoFactorText = /verification code|two-factor authentication|enter the code/i;
    const needsTwoFactor =
      (await isVisible(authFrame.getByText(twoFactorText).first())) ||
      (await isVisible(page.getByText(twoFactorText).first()));
    if (needsTwoFactor) {
      throw new ICloudError(
        "TWO_FACTOR_REQUIRED",
        "Run 'npx apple-reminders-icloud-mcp auth' to finish Apple two-factor authentication, then retry.",
      );
    }
    if (await isVisible(page.locator("iframe#aid-auth-widget-iFrame"))) {
      throw new ICloudError(
        "AUTH_REQUIRED",
        "Run 'npx apple-reminders-icloud-mcp auth' to sign in to iCloud, then retry.",
      );
    }

    try {
      await tree.waitFor({ state: "visible", timeout: 17_000 });
      return tree;
    } catch {}

    if (!page.url().includes("icloud.com/reminders")) {
      throw new ICloudError("LISTS_UNAVAILABLE", "iCloud Reminders is unavailable for this session.");
    }
    throw new ICloudError(
      "PAGE_STRUCTURE_CHANGED",
      "Could not find the iCloud reminder-list tree. Apple may have changed the page structure.",
    );
  }
}

async function waitForReminderView(page: Page): Promise<void> {
  // Give Apple's click handler one task to attach its loading marker, then wait on that marker.
  await page.waitForTimeout(50);
  try {
    await page.frameLocator("iframe#early-child").locator(".rm-loading").waitFor({ state: "hidden", timeout: 15_000 });
  } catch {
    throw new ICloudError("LISTS_UNAVAILABLE", "iCloud did not finish loading the reminder list.");
  }
}

async function scanReminderLists(): Promise<{
  page: Page;
  items: Locator;
  selected: number;
  lists: ReminderList[];
}> {
  const page = await getPage();
  const tree = await requireReminderTree(page);
  const items = tree.locator(":scope > [role=treeitem]");
  const count = await items.count();
  if (count === 0) {
    throw new ICloudError("LISTS_UNAVAILABLE", "No reminder lists are available in iCloud.");
  }

  const selected = await items.evaluateAll((elements) =>
    elements.findIndex((element) => element.getAttribute("aria-selected") === "true"),
  );
  const occurrences = new Map<string, number>();
  const lists: ReminderList[] = [];

  for (let index = 0; index < count; index += 1) {
    const item = items.nth(index);
    const name = (await item.locator(".inline-editable-label").innerText()).trim();
    if (!name) {
      throw new ICloudError("PAGE_STRUCTURE_CHANGED", "A reminder list is missing its visible name.");
    }

    const occurrence = occurrences.get(name) ?? 0;
    occurrences.set(name, occurrence + 1);
    lists.push({
      id: deriveListId(name, occurrence),
      name,
      idSource: "derived",
    });
  }
  return { page, items, selected, lists };
}

export async function listReminderLists(): Promise<ReminderList[]> {
  return (await scanReminderLists()).lists;
}

async function selectReminderList(listId?: string) {
  const scan = await scanReminderLists();
  const index =
    listId === undefined
      ? scan.selected >= 0
        ? scan.selected
        : 0
      : scan.lists.findIndex((list) => list.id === listId);
  if (index < 0) {
    throw new ICloudError("LIST_NOT_FOUND", `Reminder list '${listId}' is unavailable.`);
  }
  await scan.items.nth(index).click();
  await waitForReminderView(scan.page);
  return { ...scan, index, list: scan.lists[index] };
}

async function restoreSelectedList(scan: Awaited<ReturnType<typeof scanReminderLists>>): Promise<void> {
  if (scan.selected >= 0 && scan.selected < scan.lists.length) {
    await scan.items.nth(scan.selected).click();
  }
}

async function readReminderRow(row: Locator, listId?: string): Promise<Reminder> {
  const parsedId = parseReminderRowId(await row.getAttribute("id"));
  const completionLabel = await row.locator("button.mark-completed").getAttribute("aria-label");
  if (!parsedId || !/as (?:in)?complete$/i.test(completionLabel ?? "")) {
    throw new ICloudError("PAGE_STRUCTURE_CHANGED", "A reminder row no longer matches the verified structure.");
  }

  const title = (await row.getByRole("textbox", { name: "Reminder" }).innerText()).trim();
  if (!title) {
    throw new ICloudError("PAGE_STRUCTURE_CHANGED", "A reminder row is missing its title.");
  }
  const notes = (await row.getByRole("textbox", { name: "Notes" }).innerText()).trim();
  const dueLocator = row.locator(".due-date");
  const due = (await dueLocator.count()) > 0 ? normalizeDueText(await dueLocator.innerText()) : null;
  return {
    id: parsedId.reminderId,
    listId: listId ?? parsedId.listId,
    title,
    notes: notes || null,
    due,
    completed: /as incomplete$/i.test(completionLabel ?? ""),
  };
}

function parseDue(dueText: string): Date {
  const due = new Date(dueText);
  if (Number.isNaN(due.getTime())) {
    throw new ICloudError("INVALID_ARGUMENT", "due must be a valid ISO 8601 date-time.");
  }
  return due;
}

async function setReminderDue(row: Locator, due: Date): Promise<void> {
  await row.hover();
  await row.getByRole("button", { name: "Edit Reminder" }).click();
  const editor = row.page().frameLocator("iframe#early-child").locator("ui-popover-content").last();
  await editor.waitFor({ state: "visible", timeout: 5_000 });

  const dateSwitch = editor.getByRole("switch", { name: "Remind me on a Day" });
  if ((await dateSwitch.getAttribute("aria-checked")) !== "true") await dateSwitch.click();

  const values: Record<string, string> = {
    month: String(due.getMonth() + 1),
    day: String(due.getDate()),
    year: String(due.getFullYear()),
    hour: String(due.getHours() % 12 || 12),
    minute: String(due.getMinutes()),
    "AM/PM": due.getHours() < 12 ? "AM" : "PM",
  };
  const timeCheckbox = editor.getByRole("checkbox");
  if ((await timeCheckbox.getAttribute("aria-checked")) !== "true") await timeCheckbox.click();
  for (const [name, value] of Object.entries(values)) {
    await editor.getByRole("spinbutton", { name }).fill(value);
  }
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await editor.waitFor({ state: "hidden", timeout: 5_000 });
}

async function findReminderRow(page: Page, reminderId: string): Promise<Locator> {
  const rows = page.frameLocator("iframe#early-child").locator('.reminder-item[id^="reminder-item-"]');
  for (let index = 0; index < (await rows.count()); index += 1) {
    if (parseReminderRowId(await rows.nth(index).getAttribute("id"))?.reminderId === reminderId) {
      return rows.nth(index);
    }
  }
  throw new ICloudError("REMINDER_NOT_FOUND", `Reminder '${reminderId}' is unavailable in this list.`);
}

export async function listReminders(listId?: string): Promise<Reminder[]> {
  const scan = await selectReminderList(listId);
  const rows = scan.page.frameLocator("iframe#early-child").locator('.reminder-item[id^="reminder-item-"]');
  const reminders: Reminder[] = [];

  try {
    for (let rowIndex = 0; rowIndex < (await rows.count()); rowIndex += 1) {
      reminders.push(await readReminderRow(rows.nth(rowIndex), scan.list.id));
    }
    return reminders;
  } finally {
    await restoreSelectedList(scan);
  }
}

export async function createReminder(title: string, listId?: string, notes?: string, due?: string): Promise<Reminder> {
  const dueDate = due === undefined ? undefined : parseDue(due);
  const scan = await selectReminderList(listId);
  try {
    const frame = scan.page.frameLocator("iframe#early-child");
    await frame.getByRole("button", { name: "Add new reminder" }).click();
    const row = frame.locator('.reminder-item[id^="reminder-item-"]').last();
    await row.getByRole("textbox", { name: "Reminder" }).fill(title);
    const notesField = row.getByRole("textbox", { name: "Notes" });
    if (notes !== undefined) {
      await notesField.fill(notes);
      await notesField.press("Tab");
    } else {
      await row.getByRole("textbox", { name: "Reminder" }).press("Tab");
    }
    // ponytail: iCloud has no save indicator; a short blur settle is the smallest verified boundary.
    await scan.page.waitForTimeout(750);
    if (dueDate !== undefined) {
      await setReminderDue(row, dueDate);
      await scan.page.waitForTimeout(750);
    }
    return await readReminderRow(row, scan.list.id);
  } catch (error) {
    if (error instanceof ICloudError) throw error;
    throw new ICloudError("WRITE_FAILED", `Could not create reminder: ${error instanceof Error ? error.message : "unknown error"}`);
  } finally {
    await restoreSelectedList(scan);
  }
}

export async function updateReminderNotes(listId: string, reminderId: string, notes: string): Promise<Reminder> {
  const scan = await selectReminderList(listId);
  try {
    const row = await findReminderRow(scan.page, reminderId);
    const notesField = row.getByRole("textbox", { name: "Notes" });
    await notesField.fill(notes);
    await notesField.press("Tab");
    await scan.page.waitForTimeout(750);
    return await readReminderRow(row, scan.list.id);
  } catch (error) {
    if (error instanceof ICloudError) throw error;
    throw new ICloudError("WRITE_FAILED", `Could not update reminder notes: ${error instanceof Error ? error.message : "unknown error"}`);
  } finally {
    await restoreSelectedList(scan);
  }
}

export async function completeReminder(
  listId: string,
  reminderId: string,
): Promise<{ id: string; listId: string; completed: true }> {
  const scan = await selectReminderList(listId);
  try {
    const row = await findReminderRow(scan.page, reminderId);
    const reminder = await readReminderRow(row, scan.list.id);
    if (reminder.completed) {
      return { id: reminder.id, listId: reminder.listId, completed: true };
    }
    await row.locator("button.mark-completed").click();
    await scan.page.waitForTimeout(750);
    const remaining = await findReminderRow(scan.page, reminderId).catch(() => undefined);
    if (remaining) {
      const label = await remaining.locator("button.mark-completed").getAttribute("aria-label");
      if (!/as incomplete$/i.test(label ?? "")) {
        throw new ICloudError("WRITE_FAILED", "iCloud did not mark the reminder complete.");
      }
    }
    return { id: reminder.id, listId: reminder.listId, completed: true };
  } catch (error) {
    if (error instanceof ICloudError) throw error;
    throw new ICloudError("WRITE_FAILED", `Could not complete reminder: ${error instanceof Error ? error.message : "unknown error"}`);
  } finally {
    await restoreSelectedList(scan);
  }
}

export async function createReminderList(name: string): Promise<ReminderList> {
  const before = await scanReminderLists();
  const occurrence = before.lists.filter((list) => list.name === name).length;
  try {
    const frame = before.page.frameLocator("iframe#early-child");
    await frame.getByRole("button", { name: "Add List" }).click();
    const modal = frame.locator(".reminder-list-modal").last();
    await modal.locator('input[type="text"]').fill(name);
    await modal.getByRole("button", { name: "Done", exact: true }).click();
    await modal.waitFor({ state: "hidden", timeout: 5_000 });
    const after = await scanReminderLists();
    const created = after.lists.filter((list) => list.name === name)[occurrence];
    if (!created) throw new ICloudError("WRITE_FAILED", "iCloud did not create the reminder list.");
    return created;
  } catch (error) {
    if (error instanceof ICloudError) throw error;
    throw new ICloudError("WRITE_FAILED", `Could not create reminder list: ${error instanceof Error ? error.message : "unknown error"}`);
  }
}

export async function renameReminderList(listId: string, name: string): Promise<ReminderList> {
  const scan = await selectReminderList(listId);
  try {
    const item = scan.items.nth(scan.index);
    const input = item.locator('.inline-editable-textfield input[type="text"]');
    if (!(await isVisible(input))) {
      await item.locator(".inline-editable-label").click();
    }
    await input.fill(name);
    await input.press("Enter");
    await input.press("Tab").catch(() => {});
    await scan.page.waitForTimeout(750);
    const after = await scanReminderLists();
    const renamed =
      scan.list.idSource === "icloud"
        ? after.lists.find((list) => list.id === scan.list.id)
        : after.lists[scan.index];
    if (!renamed || renamed.name !== name) {
      throw new ICloudError("WRITE_FAILED", "iCloud did not rename the reminder list.");
    }
    return renamed;
  } catch (error) {
    if (error instanceof ICloudError) throw error;
    throw new ICloudError("WRITE_FAILED", `Could not rename reminder list: ${error instanceof Error ? error.message : "unknown error"}`);
  }
}

export async function closeICloud(): Promise<void> {
  await context?.close();
  context = undefined;
}

export async function authenticateICloud(): Promise<void> {
  const authContext = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: "chrome",
    executablePath: process.env.ICLOUD_BROWSER_PATH,
    headless: false,
  });
  try {
    const page = authContext.pages()[0] ?? (await authContext.newPage());
    await page.goto(ICLOUD_URL, { waitUntil: "domcontentloaded" });
    if (!(await findAuthenticatedPage(authContext.pages()))) {
      const signIn = page.getByText("Sign In", { exact: true }).first();
      if (await isVisible(signIn)) await signIn.click();
      console.error("Complete Apple sign-in and two-factor authentication in Chrome.");
      const deadline = Date.now() + 10 * 60_000;
      // ponytail: polling keeps redirects and new tabs on one path; use page events if Apple starts opening many tabs.
      while (!(await findAuthenticatedPage(authContext.pages()))) {
        if (authContext.pages().length === 0) {
          throw new ICloudError("AUTH_REQUIRED", "Chrome was closed before iCloud Reminders finished loading.");
        }
        if (Date.now() >= deadline) {
          throw new ICloudError("AUTH_REQUIRED", "Timed out waiting for iCloud Reminders after sign-in.");
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 500));
      }
    }
    console.error("iCloud authentication is ready. Chrome will close.");
  } finally {
    await authContext.close();
  }
}
