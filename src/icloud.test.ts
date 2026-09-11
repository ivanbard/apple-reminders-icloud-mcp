import assert from "node:assert/strict";
import test from "node:test";
import { deriveListId, normalizeDueText, parseListIdFromReminderRow, parseReminderRowId } from "./icloud.js";

test("extracts the native list ID from an iCloud reminder row", () => {
  assert.equal(
    parseListIdFromReminderRow(
      "reminder-item-_example-list-id:Reminders Reminder/11111111-2222-4333-8444-555555555555",
    ),
    "_example-list-id:Reminders",
  );
  assert.equal(parseListIdFromReminderRow("changed-markup"), undefined);
});

test("extracts both native IDs from an iCloud reminder row", () => {
  assert.deepEqual(
    parseReminderRowId(
      "reminder-item-_example-list-id:Reminders Reminder/11111111-2222-4333-8444-555555555555",
    ),
    {
      listId: "_example-list-id:Reminders",
      reminderId: "11111111-2222-4333-8444-555555555555",
    },
  );
  assert.equal(parseReminderRowId("changed-markup"), undefined);
});

test("derived IDs are deterministic and disambiguate duplicate names", () => {
  assert.equal(deriveListId("Personal"), deriveListId("Personal"));
  assert.notEqual(deriveListId("Personal", 0), deriveListId("Personal", 1));
});

test("uses the semantic due-date line instead of duplicated hidden text", () => {
  assert.equal(normalizeDueText("Today, 9:30 AM, Overdue\nToday, 9:30 AM"), "Today, 9:30 AM, Overdue");
  assert.equal(normalizeDueText(""), null);
});
