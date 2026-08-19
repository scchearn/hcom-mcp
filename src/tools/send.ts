import { z } from "zod";
import { execHcom, resolveCallerName } from "../hcom.js";

const SendIntentEnum = z.enum(["request", "inform", "ack"]);

export function registerSendTool(server: any) {
  server.tool(
    "send",
    "Send an hcom message to one or more agents. Unbound HTTP MCP clients can launch, inspect, and kill agents but could not message them — this closes that gap. No broadcast, no --from, no file variants.",
    {
      targets: z.array(z.string()).min(1).describe("Target agents/tags, e.g. ['@eng-', '@review-']. @ prefix optional; tag syntax ('@tag-') fans out to the group."),
      message: z.string().describe("Message body."),
      intent: SendIntentEnum.optional().describe("Intent (default: inform). request expects a response; ack requires reply_to."),
      reply_to: z.string().optional().describe("Event ID to reply to (e.g. '42' or '42:BOXE'). Required for intent=ack."),
      sender_name: z.string().optional().describe("Sender identity for hcom delivery. Required for HTTP or unbound MCP callers when auto-resolution is unavailable."),
    },
    async ({ targets, message, intent, reply_to, sender_name }: {
      targets: string[];
      message: string;
      intent?: "request" | "inform" | "ack";
      reply_to?: string;
      sender_name?: string;
    }) => {
      try {
        const resolvedSender = await resolveCallerName(sender_name);
        if (!resolvedSender) {
          return {
            content: [{
              type: "text" as const,
              text: "Error: Cannot resolve sender identity. For HTTP or unbound MCP callers, provide the sender_name parameter explicitly. Bound hcom sessions may auto-resolve via 'hcom list self'.",
            }],
            isError: true,
          };
        }

        const effectiveIntent = intent ?? "inform";
        if (effectiveIntent === "ack" && !reply_to) {
          return {
            content: [{
              type: "text" as const,
              text: "Error: intent=ack requires reply_to (the event id being acknowledged).",
            }],
            isError: true,
          };
        }

        const mentions = targets.map((t) => (t.startsWith("@") ? t : `@${t}`));

        const args = ["send", ...mentions, "--name", resolvedSender, "--intent", effectiveIntent];
        if (reply_to) args.push("--reply-to", reply_to);
        args.push("--", message);

        const result = await execHcom(args);

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify(
              {
                targets: mentions,
                intent: effectiveIntent,
                sender_name: resolvedSender,
                delivered: result.exitCode === 0,
                output: result.stdout || result.stderr,
              },
              null,
              2,
            ),
          }],
          ...(result.exitCode !== 0 ? { isError: true as const } : {}),
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
