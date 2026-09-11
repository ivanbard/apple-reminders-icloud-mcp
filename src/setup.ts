import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { authenticateICloud } from "./icloud.js";

const SERVER_NAME = "apple-reminders-icloud";
const PACKAGE = "apple-reminders-icloud-mcp@latest";

type McpConfig = {
  mcpServers?: Record<string, unknown>;
  [key: string]: unknown;
};

export function serverCommand(): { command: string; args: string[] } {
  return platform() === "win32"
    ? { command: "cmd", args: ["/c", "npx", "-y", PACKAGE] }
    : { command: "npx", args: ["-y", PACKAGE] };
}

export function configureJsonClient(configPath: string): void {
  let config: McpConfig = {};
  if (existsSync(configPath)) config = JSON.parse(readFileSync(configPath, "utf8")) as McpConfig;
  if (config.mcpServers !== undefined && (typeof config.mcpServers !== "object" || Array.isArray(config.mcpServers))) {
    throw new Error(`Invalid mcpServers value in ${configPath}`);
  }
  config.mcpServers ??= {};
  config.mcpServers[SERVER_NAME] = serverCommand();
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

function claudeConfigPath(): string {
  if (platform() === "darwin") return join(homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
  if (platform() === "linux") return join(homedir(), ".config", "Claude", "claude_desktop_config.json");
  return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
}

function configureCodex(): void {
  const server = serverCommand();
  const result = spawnSync("codex", ["mcp", "add", SERVER_NAME, "--", server.command, ...server.args], {
    stdio: "inherit",
    shell: platform() === "win32",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error("Codex CLI could not register the MCP server.");
}

export async function runSetup(): Promise<void> {
  console.log("\nApple Reminders iCloud MCP — Setup\n");
  console.log("A Chrome window will open. Sign in to Apple and complete two-factor authentication there.\n");
  await authenticateICloud();

  const rl = createInterface({ input, output });
  try {
    console.log("\nChoose the MCP client to configure:");
    console.log("  1. Claude Desktop");
    console.log("  2. Cursor");
    console.log("  3. Codex");
    console.log("  4. Show manual configuration");

    let choice = "";
    while (!/^[1-4]$/.test(choice)) choice = (await rl.question("\nClient [1-4]: ")).trim();

    if (choice === "1") configureJsonClient(claudeConfigPath());
    if (choice === "2") configureJsonClient(join(homedir(), ".cursor", "mcp.json"));
    if (choice === "3") configureCodex();
    if (choice === "4") console.log(`\n${JSON.stringify(serverCommand(), null, 2)}`);

    console.log(choice === "4" ? "\nAuthentication is ready." : "\nSetup complete. Restart your MCP client to connect.");
  } finally {
    rl.close();
  }
}
