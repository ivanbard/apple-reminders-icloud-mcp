import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  closeICloud,
  completeReminder,
  createReminder,
  createReminderList,
  ICloudError,
  listReminderLists,
  listReminders,
  renameReminderList,
  updateReminderNotes,
} from "./icloud.js";

const listSchema = {
  type: "object" as const,
  properties: {
    id: { type: "string" as const },
    name: { type: "string" as const },
    idSource: { type: "string" as const, enum: ["icloud", "derived"] },
  },
  required: ["id", "name", "idSource"],
  additionalProperties: false,
};

const reminderSchema = {
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
};

const listOutputSchema = {
  type: "object" as const,
  properties: {
    lists: {
      type: "array" as const,
      items: listSchema,
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
      items: reminderSchema,
    },
  },
  required: ["reminders"],
  additionalProperties: false,
};

const singleListOutputSchema = {
  type: "object" as const,
  properties: { list: listSchema },
  required: ["list"],
  additionalProperties: false,
};

const singleReminderOutputSchema = {
  type: "object" as const,
  properties: { reminder: reminderSchema },
  required: ["reminder"],
  additionalProperties: false,
};

const completionOutputSchema = {
  type: "object" as const,
  properties: {
    id: { type: "string" as const },
    listId: { type: "string" as const },
    completed: { type: "boolean" as const, const: true },
  },
  required: ["id", "listId", "completed"],
  additionalProperties: false,
};

const writeAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};

const server = new Server(
  { name: "apple-reminders-icloud", version: "0.2.0" },
  {
    capabilities: { tools: {} },
    instructions:
      "Use this local headless server to read and manage Apple Reminders through iCloud.com. If authentication is required, tell the user to run 'npm run auth'. Never request Apple credentials or 2FA codes. Deletion is not available.",
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
    {
      name: "create_reminder",
      description: "Create an Apple Reminder in the selected or specified iCloud reminder list.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", minLength: 1 },
          listId: { type: "string", minLength: 1 },
          notes: { type: "string" },
          due: { type: "string", format: "date-time" },
        },
        required: ["title"],
        additionalProperties: false,
      },
      outputSchema: singleReminderOutputSchema,
      annotations: writeAnnotations,
    },
    {
      name: "complete_reminder",
      description: "Mark one Apple Reminder complete using its stable reminder and list identifiers.",
      inputSchema: {
        type: "object",
        properties: {
          listId: { type: "string", minLength: 1 },
          reminderId: { type: "string", minLength: 1 },
        },
        required: ["listId", "reminderId"],
        additionalProperties: false,
      },
      outputSchema: completionOutputSchema,
      annotations: writeAnnotations,
    },
    {
      name: "update_reminder_notes",
      description: "Replace the notes on one Apple Reminder. Pass an empty string to clear them.",
      inputSchema: {
        type: "object",
        properties: {
          listId: { type: "string", minLength: 1 },
          reminderId: { type: "string", minLength: 1 },
          notes: { type: "string" },
        },
        required: ["listId", "reminderId", "notes"],
        additionalProperties: false,
      },
      outputSchema: singleReminderOutputSchema,
      annotations: { ...writeAnnotations, idempotentHint: true },
    },
    {
      name: "create_reminder_list",
      description: "Create a private Apple Reminders list in iCloud.",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string", minLength: 1 } },
        required: ["name"],
        additionalProperties: false,
      },
      outputSchema: singleListOutputSchema,
      annotations: writeAnnotations,
    },
    {
      name: "rename_reminder_list",
      description: "Rename an Apple Reminders list. This does not change its reminders.",
      inputSchema: {
        type: "object",
        properties: {
          listId: { type: "string", minLength: 1 },
          name: { type: "string", minLength: 1 },
        },
        required: ["listId", "name"],
        additionalProperties: false,
      },
      outputSchema: singleListOutputSchema,
      annotations: { ...writeAnnotations, idempotentHint: true },
    },
  ],
}));

function requireString(args: Record<string, unknown>, name: string, allowEmpty = false): string {
  const value = args[name];
  if (typeof value !== "string" || (!allowEmpty && !value.trim())) {
    throw new ICloudError("INVALID_ARGUMENT", `${name} must be ${allowEmpty ? "a string" : "a nonempty string"}.`);
  }
  return allowEmpty ? value : value.trim();
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    let structuredContent: Record<string, unknown>;
    switch (request.params.name) {
      case "list_reminder_lists":
        structuredContent = { lists: await listReminderLists() };
        break;
      case "list_reminders":
        structuredContent = {
          reminders: await listReminders(args.listId === undefined ? undefined : requireString(args, "listId")),
        };
        break;
      case "create_reminder":
        structuredContent = {
          reminder: await createReminder(
            requireString(args, "title"),
            args.listId === undefined ? undefined : requireString(args, "listId"),
            args.notes === undefined ? undefined : requireString(args, "notes", true),
            args.due === undefined ? undefined : requireString(args, "due"),
          ),
        };
        break;
      case "complete_reminder":
        structuredContent = await completeReminder(
          requireString(args, "listId"),
          requireString(args, "reminderId"),
        );
        break;
      case "update_reminder_notes":
        structuredContent = {
          reminder: await updateReminderNotes(
            requireString(args, "listId"),
            requireString(args, "reminderId"),
            requireString(args, "notes", true),
          ),
        };
        break;
      case "create_reminder_list":
        structuredContent = { list: await createReminderList(requireString(args, "name")) };
        break;
      case "rename_reminder_list":
        structuredContent = {
          list: await renameReminderList(requireString(args, "listId"), requireString(args, "name")),
        };
        break;
      default:
        return {
          isError: true,
          content: [{ type: "text", text: JSON.stringify({ error: { code: "UNKNOWN_TOOL", message: "Unknown tool." } }) }],
        };
    }
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
