import { z } from "zod";
import { execHcom, parseHcomJson, resolveCallerName } from "../hcom.js";

export function registerThreadSeedTool(server: any) {
  server.tool(
    "thread_seed",
    "Create a workflow thread. Auto-includes the hub (calling agent) in the member list so the hub receives thread messages. Use instead of raw hcom send for thread creation when hcom-mcp is available.",
    {
      thread_name: z.string().describe("Thread name, e.g. 'repo-task-1747354927'"),
      mentions: z.array(z.string()).describe("Target agents/tags, e.g. ['@eng-', '@review-']. @ prefix optional."),
      message: z.string().describe("Seed message body"),
      intent: z.enum(["request", "inform", "ack"]).optional().describe("Intent (default: inform)"),
      sender_name: z.string().optional().describe("Sender identity for hcom delivery. Required for HTTP or unbound MCP callers when auto-resolution is unavailable."),
      hub_name: z.string().optional().describe("Hub agent name. Required for HTTP or unbound MCP callers when auto-resolution is unavailable."),
    },
    async ({
      thread_name,
      mentions,
      message,
      intent,
      sender_name,
      hub_name,
    }: {
      thread_name: string;
      mentions: string[];
      message: string;
      intent?: "request" | "inform" | "ack";
      sender_name?: string;
      hub_name?: string;
    }) => {
      try {
        const resolvedSender = await resolveCallerName(sender_name);
        const resolvedHub = await resolveCallerName(hub_name);

        if (!resolvedSender) {
          return {
            content: [{
              type: "text" as const,
              text: "Error: Cannot resolve sender identity. For HTTP or unbound MCP callers, provide the sender_name parameter explicitly. Bound hcom sessions may auto-resolve via 'hcom list self'.",
            }],
            isError: true,
          };
        }

        if (!resolvedHub) {
          return {
            content: [{
              type: "text" as const,
              text: "Error: Cannot resolve hub name. For HTTP or unbound MCP callers, provide the hub_name parameter explicitly. Bound hcom sessions may auto-resolve via 'hcom list self'.",
            }],
            isError: true,
          };
        }

        const normalizedMentions = mentions.map((m) => (m.startsWith("@") ? m : `@${m}`));

        const hubMention = `@${resolvedHub}`;
        const allMentions = normalizedMentions.some((m) => m === hubMention)
          ? normalizedMentions
          : [hubMention, ...normalizedMentions];

        const sendArgs = [
          "send",
          ...allMentions,
          "--name",
          resolvedSender,
          "--thread",
          thread_name,
          "--intent",
          intent ?? "inform",
          "--",
          message,
        ];

        const result = await execHcom(sendArgs);

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify(
              {
                thread_name,
                sender_name: resolvedSender,
                hub_name: resolvedHub,
                mentions: allMentions,
                seed_delivered: result.exitCode === 0,
                output: result.stdout || result.stderr,
              },
              null,
              2,
            ),
          }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    },
  );
}

export function registerThreadInspectTool(server: any) {
  server.tool(
    "thread_inspect",
    "Query thread events with structured output. Read-only. Use to inspect what happened on a workflow thread.",
    {
      thread_name: z.string().describe("Thread name to query"),
      last: z.number().optional().describe("Limit number of events (default: 20)"),
      from: z.string().optional().describe("Filter by sender name"),
      intent: z.enum(["request", "inform", "ack"]).optional().describe("Filter by intent"),
      event_type: z.enum(["message", "status", "life"]).optional().describe("Filter by event type"),
    },
    async ({
      thread_name,
      last,
      from,
      intent,
      event_type,
    }: {
      thread_name: string;
      last?: number;
      from?: string;
      intent?: "request" | "inform" | "ack";
      event_type?: "message" | "status" | "life";
    }) => {
      try {
        const args = [
          "events",
          "--thread",
          thread_name,
          "--last",
          String(last ?? 20),
        ];

        if (from) args.push("--from", from);
        if (intent) args.push("--intent", intent);
        if (event_type) args.push("--type", event_type);

        const result = await execHcom(args);

        if (result.exitCode !== 0) {
          return {
            content: [{
              type: "text" as const,
              text: `Error querying thread: ${result.stderr || result.stdout}`,
            }],
            isError: true,
          };
        }

        const events = result.stdout
          .split("\n")
          .filter((line: string) => line.trim())
          .map((line: string) => parseHcomJson(line))
          .filter(Boolean);

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify(
              {
                thread_name,
                event_count: events.length,
                events,
              },
              null,
              2,
            ),
          }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    },
  );
}
