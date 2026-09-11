import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { configureJsonClient, serverCommand } from "./setup.js";

test("configures an npm MCP command without removing existing servers", () => {
  const dir = mkdtempSync(join(tmpdir(), "apple-reminders-setup-"));
  const path = join(dir, "mcp.json");
  writeFileSync(path, JSON.stringify({ mcpServers: { existing: { command: "existing" } }, keep: true }));

  configureJsonClient(path);

  const config = JSON.parse(readFileSync(path, "utf8"));
  assert.deepEqual(config.mcpServers.existing, { command: "existing" });
  assert.deepEqual(config.mcpServers["apple-reminders-icloud"], serverCommand());
  assert.equal(config.keep, true);
});
