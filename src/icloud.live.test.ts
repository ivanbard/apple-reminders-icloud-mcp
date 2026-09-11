import assert from "node:assert/strict";
import test from "node:test";
import {
  closeICloud,
  createReminder,
  createReminderList,
  listReminderLists,
  listReminders,
  updateReminderNotes,
} from "./icloud.js";

test("headless iCloud read and write flow", { timeout: 120_000 }, async () => {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const due = new Date();
  due.setDate(due.getDate() + 1);
  due.setHours(9, 0, 0, 0);

  try {
    const lists = await listReminderLists();
    assert.ok(lists.length > 0, "expected at least one existing reminder list");

    const existing = [];
    for (const list of lists) existing.push(...(await listReminders(list.id)));
    assert.ok(existing.every((reminder) => reminder.due === null || typeof reminder.due === "string"));

    const scheduled = await createReminder(
      `MCP headless scheduled test ${stamp}`,
      undefined,
      "Created by the headless MCP live test; safe to remove after inspection.",
      due.toISOString(),
    );
    assert.equal(scheduled.notes, "Created by the headless MCP live test; safe to remove after inspection.");
    assert.ok(scheduled.due, "expected the scheduled reminder to have a due date");
    assert.match(scheduled.due, /9:00 AM/);

    const list = await createReminderList(`MCP Headless Test ${stamp}`);
    const created = await createReminder(
      `List reminder test ${stamp}`,
      list.id,
      "Initial notes from the headless MCP live test.",
    );
    const updated = await updateReminderNotes(
      created.listId,
      created.id,
      "Updated notes from the headless MCP live test.",
    );
    assert.equal(updated.notes, "Updated notes from the headless MCP live test.");
    assert.ok((await listReminders(created.listId)).some((reminder) => reminder.id === created.id));

    console.log(JSON.stringify({
      existingReminderCount: existing.length,
      existingDueDates: existing.filter((reminder) => reminder.due).map(({ title, due }) => ({ title, due })),
      scheduled,
      testList: list,
      testListReminder: updated,
    }, null, 2));
  } finally {
    await closeICloud();
  }
});
