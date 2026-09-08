import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { closeICloud, ICloudError, listReminderLists } from "./icloud.js";

const outputSchema = {
  type: "object" as const,
  properties: {
    lists: {
      type: "array" as const,
      items: {
        type: "object" as const,
        properties: {
          id: { type: "string" as const },
          name: { type: "string" as const },
          idSource: { type: "string" as const, enum: ["icloud", "derived"] },
        },
        required: ["id", "name", "idSource"],
        additionalProperties: false,
      },
    },
  },
  required: ["lists"],
  additionalProperties: false,
};

const server = new Server(
  { name: "apple-reminders-icloud", version: "0.1.0" },
  {
    capabilities: { tools: {} },
    instructions:
      "Use this local server to access Apple Reminders through iCloud.com. Authentication happens only in its visible browser. Never request Apple credentials or 2FA codes. This MVP is read-only and exposes only list_reminder_lists.",
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "list_reminder_lists",
      description: "List Apple Reminders lists available in the authenticated iCloud session.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      outputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== "list_reminder_lists") {
    return {
      isError: true,
      content: [{ type: "text", text: JSON.stringify({ error: { code: "UNKNOWN_TOOL", message: "Unknown tool." } }) }],
    };
  }

  try {
    const structuredContent = { lists: await listReminderLists() };
    return {
      content: [{ type: "text", text: JSON.stringify(structuredContent) }],
      structuredContent,
    };
  } catch (error) {
    const code = error instanceof ICloudError ? error.code : "ICLOUD_ERROR";
    const message = error instanceof Error ? error.message : "Unknown iCloud error.";
    return {
      isError: true,
      content: [{ type: "text", text: JSON.stringify({ error: { code, message } }) }],
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    await closeICloud();
    process.exit(0);
  });
}
