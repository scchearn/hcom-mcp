import { z } from "zod";
import { execHcom, parseHcomJson, resolveCallerName } from "../hcom.js";
import { E_NO_SENDER, E_THREAD_FAILED, toolError } from "../errors.js";

export function registerThreadSeedTool(server: any) {
  server.tool(
    "thread_seed",
    "Create a workflow thread. Auto-includes the hub (calling agent) so it receives thread messages. Use instead of raw hcom send for thread creation when hcom-mcp is available. The thread exists once the first --thread send lands; there is no separate creation step.",
    {
      thread_name: z.string().describe("Thread name, e.g. 'repo-task-1747354927'"),
      mentions: z.array(z.string()).describe("Target agents/tags, e.g. ['@eng-', '@review-']. @ prefix optional."),
      message: z.string().describe("Seed message body"),
      intent: z.enum(["request", "inform", "ack"]).optional().describe("Intent (default: inform)"),
      sender_name: z.string().optional().describe("Sender identity for hcom delivery. REQUIRED for HTTP or unbound MCP callers: auto-resolution via 'hcom list self' never succeeds there, and the call fails with E_NO_SENDER. Bound hcom sessions may omit it."),
      hub_name: z.string().optional().describe("Hub agent name. Defaults to sender_name when omitted. Only override when the hub differs from the sender."),
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
        // hub_name defaults to the resolved sender; the hub is the caller
        // unless explicitly overridden.
        const resolvedHub = await resolveCallerName(hub_name ?? resolvedSender);

        if (!resolvedSender) {
          return toolError(
            E_NO_SENDER,
            "Cannot resolve sender identity. For HTTP or unbound MCP callers, provide the sender_name parameter explicitly. Bound hcom sessions may auto-resolve via 'hcom list self'.",
          );
        }

        if (!resolvedHub) {
          return toolError(
            E_NO_SENDER,
            "Cannot resolve hub name. For HTTP or unbound MCP callers, provide the sender_name parameter explicitly (hub_name defaults to it). Bound hcom sessions may auto-resolve via 'hcom list self'.",
          );
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
                threadName: thread_name,
                senderName: resolvedSender,
                hubName: resolvedHub,
                mentions: allMentions,
                seedDelivered: result.exitCode === 0,
                output: result.stdout || result.stderr,
              },
              null,
              2,
            ),
          }],
        };
      } catch (err: any) {
        return toolError(E_THREAD_FAILED, err.message);
      }
    },
  );
}

export function registerThreadInspectTool(server: any) {
  server.tool(
    "thread_inspect",
    "Query thread events with structured output. Read-only; no sender identity required. Returns { threadName, eventCount, events }. See also thread_seed to create threads.",
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
          return toolError(
            E_THREAD_FAILED,
            `Error querying thread: ${result.stderr || result.stdout}`,
          );
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
                threadName: thread_name,
                eventCount: events.length,
                events,
              },
              null,
              2,
            ),
          }],
        };
      } catch (err: any) {
        return toolError(E_THREAD_FAILED, err.message);
      }
    },
  );
}
