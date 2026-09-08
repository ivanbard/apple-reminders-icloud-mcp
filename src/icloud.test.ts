import assert from "node:assert/strict";
import test from "node:test";
import { deriveListId, parseListIdFromReminderRow } from "./icloud.js";

test("extracts the native list ID from an iCloud reminder row", () => {
  assert.equal(
    parseListIdFromReminderRow(
      "reminder-item-_example-list-id:Reminders Reminder/11111111-2222-4333-8444-555555555555",
    ),
    "_example-list-id:Reminders",
  );
  assert.equal(parseListIdFromReminderRow("changed-markup"), undefined);
});

test("derived IDs are deterministic and disambiguate duplicate names", () => {
  assert.equal(deriveListId("Personal"), deriveListId("Personal"));
  assert.notEqual(deriveListId("Personal", 0), deriveListId("Personal", 1));
});
