import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { closeICloud, ICloudError, listReminderLists, listReminders } from "./icloud.js";

const listOutputSchema = {
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

const reminderOutputSchema = {
  type: "object" as const,
  properties: {
    reminders: {
      type: "array" as const,
      items: {
        type: "object" as const,
        properties: {
          id: { type: "string" as const },
          listId: { type: "string" as const },
          title: { type: "string" as const },
          notes: { type: ["string", "null"] as const },
          due: { type: ["string", "null"] as const },
          completed: { type: "boolean" as const },
        },
        required: ["id", "listId", "title", "notes", "due", "completed"],
        additionalProperties: false,
      },
    },
  },
  required: ["reminders"],
  additionalProperties: false,
};

const server = new Server(
  { name: "apple-reminders-icloud", version: "0.1.0" },
  {
    capabilities: { tools: {} },
    instructions:
      "Use this local server to read Apple Reminders through iCloud.com. Authentication happens only in its visible browser. Never request Apple credentials or 2FA codes. This server is read-only.",
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "list_reminder_lists",
      description: "List Apple Reminders lists available in the authenticated iCloud session.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      outputSchema: listOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    {
      name: "list_reminders",
      description: "List the visible reminders in an iCloud reminder list, including title, notes, due text, and completion state.",
      inputSchema: {
        type: "object",
        properties: { listId: { type: "string", minLength: 1 } },
        additionalProperties: false,
      },
      outputSchema: reminderOutputSchema,
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
  if (!["list_reminder_lists", "list_reminders"].includes(request.params.name)) {
    return {
      isError: true,
      content: [{ type: "text", text: JSON.stringify({ error: { code: "UNKNOWN_TOOL", message: "Unknown tool." } }) }],
    };
  }

  try {
    const listId = request.params.arguments?.listId;
    if (listId !== undefined && (typeof listId !== "string" || !listId.trim())) {
      throw new ICloudError("LIST_NOT_FOUND", "listId must be a nonempty string.");
    }
    const structuredContent =
      request.params.name === "list_reminder_lists"
        ? { lists: await listReminderLists() }
        : { reminders: await listReminders(listId as string | undefined) };
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
