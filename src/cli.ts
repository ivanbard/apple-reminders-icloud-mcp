#!/usr/bin/env node

try {
  const command = process.argv[2];
  if (command === "setup") {
    const { runSetup } = await import("./setup.js");
    await runSetup();
  } else if (command === "auth") {
    await import("./auth.js");
  } else if (command === "--help" || command === "-h") {
    console.log("Usage: apple-reminders-icloud-mcp [setup|auth]");
  } else if (command) {
    throw new Error(`Unknown command: ${command}\nRun with --help for usage.`);
  } else {
    await import("./index.js");
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
