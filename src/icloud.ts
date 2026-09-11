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

async function getPage(): Promise<Page> {
  context ??= await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: "chrome",
    executablePath: process.env.ICLOUD_BROWSER_PATH,
    headless: false,
  });

  const pages = context.pages();
  const page = pages.find((candidate) => candidate.url().includes("icloud.com/reminders")) ?? pages[0] ?? (await context.newPage());
  await page.bringToFront();
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
      await signIn.click();
      await page.locator("iframe#aid-auth-widget-iFrame").waitFor({ state: "visible", timeout: 5_000 }).catch(() => {});
      throw new ICloudError(
        "AUTH_REQUIRED",
        "Finish signing in to iCloud in the visible browser. The server never reads your password or verification code.",
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
        "Finish Apple two-factor authentication in the visible browser, then retry.",
      );
    }
    if (await isVisible(page.locator("iframe#aid-auth-widget-iFrame"))) {
      throw new ICloudError(
        "AUTH_REQUIRED",
        "Sign in to iCloud in the visible browser. The server never reads your password or verification code.",
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

    await item.click();
    // ponytail: short settle for Apple's client render; replace if the DOM gains a reliable loading signal.
    await page.waitForTimeout(250);
    const rowId = await page
      .frameLocator("iframe#early-child")
      .locator('[id^="reminder-item-"]')
      .first()
      .getAttribute("id")
      .catch(() => null);
    const nativeId = parseListIdFromReminderRow(rowId);
    const occurrence = occurrences.get(name) ?? 0;
    occurrences.set(name, occurrence + 1);
    lists.push({
      id: nativeId ?? deriveListId(name, occurrence),
      name,
      idSource: nativeId ? "icloud" : "derived",
    });
  }

  if (selected >= 0 && selected < count) {
    await items.nth(selected).click();
  }
  return { page, items, selected, lists };
}

export async function listReminderLists(): Promise<ReminderList[]> {
  return (await scanReminderLists()).lists;
}

export async function listReminders(listId?: string): Promise<Reminder[]> {
  const scan = await scanReminderLists();
  const index = listId === undefined ? (scan.selected >= 0 ? scan.selected : 0) : scan.lists.findIndex((list) => list.id === listId);
  if (index < 0) {
    throw new ICloudError("LIST_NOT_FOUND", `Reminder list '${listId}' is unavailable.`);
  }

  await scan.items.nth(index).click();
  // ponytail: short settle for Apple's client render; replace if the DOM gains a reliable loading signal.
  await scan.page.waitForTimeout(250);
  const rows = scan.page.frameLocator("iframe#early-child").locator('.reminder-item[id^="reminder-item-"]');
  const reminders: Reminder[] = [];

  try {
    for (let rowIndex = 0; rowIndex < (await rows.count()); rowIndex += 1) {
      const row = rows.nth(rowIndex);
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
      reminders.push({
        id: parsedId.reminderId,
        listId: parsedId.listId,
        title,
        notes: notes || null,
        due,
        completed: /as incomplete$/i.test(completionLabel ?? ""),
      });
    }
    return reminders;
  } finally {
    if (scan.selected >= 0 && scan.selected < scan.lists.length) {
      await scan.items.nth(scan.selected).click();
    }
  }
}

export async function closeICloud(): Promise<void> {
  await context?.close();
  context = undefined;
}
