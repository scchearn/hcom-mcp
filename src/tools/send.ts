import { z } from "zod";
import { execHcom, resolveCallerName } from "../hcom.js";
import { E_ACK_REQUIRES_REPLY_TO, E_NO_SENDER, E_SEND_FAILED, toolError } from "../errors.js";

const SendIntentEnum = z.enum(["request", "inform", "ack"]);

export function registerSendTool(server: any) {
  server.tool(
    "send",
    "Send an hcom message to one or more agents. No broadcast, no --from, no file variants. Preconditions: sender identity (see sender_name); intent=ack requires reply_to (E_ACK_REQUIRES_REPLY_TO). Related: thread_seed (thread creation), watch_agents (subscribe mode).",
    {
      targets: z.array(z.string()).min(1).describe("Target agents/tags, e.g. ['@eng-', '@review-']. @ prefix optional; tag syntax ('@tag-') fans out to the group."),
      message: z.string().describe("Message body."),
      intent: SendIntentEnum.optional().describe("Intent (default: inform). request expects a response; ack requires reply_to."),
      reply_to: z.string().optional().describe("Event ID to reply to (e.g. '42' or '42:BOXE'). Required for intent=ack."),
      sender_name: z.string().optional().describe("Sender identity for hcom delivery. REQUIRED for HTTP or unbound MCP callers: auto-resolution via 'hcom list self' never succeeds there, and the call fails with E_NO_SENDER. Bound hcom sessions may omit it."),
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
          return toolError(
            E_NO_SENDER,
            "Cannot resolve sender identity. For HTTP or unbound MCP callers, provide the sender_name parameter explicitly. Bound hcom sessions may auto-resolve via 'hcom list self'.",
          );
        }

        const effectiveIntent = intent ?? "inform";
        if (effectiveIntent === "ack" && !reply_to) {
          return toolError(E_ACK_REQUIRES_REPLY_TO, "intent=ack requires reply_to (the event id being acknowledged).");
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
                senderName: resolvedSender,
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
        return toolError(E_SEND_FAILED, err.message);
      }
    },
  );
}
