import { z } from "zod";
import { execHcom, resolveCallerName, listHcomAgents, findLiveAgentByIdentifier, inferHarnessFromTool } from "../hcom.js";
import { adoptRecord, findRecordByWorkspaceAndName } from "../registry.js";
import type { Harness } from "../types.js";

function defaultAdoptNotice(hub: string, name: string, harness: Harness, workspace: string): string {
  return [
    "You have been adopted into hcom-mcp managed lifecycle.",
    `hub: ${hub}  your name: ${name}  harness: ${harness}  workspace: ${workspace}`,
    `Stop/kill commands from ${hub} are now authoritative for your session.`,
    "Your system prompt and task are unchanged.",
    `Load the "hcom" skill so you can correctly route hcom messages and acks.`,
    `Acknowledge this adoption by replying: "Ready, ${hub} is hub"`,
  ].join("\n");
}

export function registerAdoptTool(server: any) {
  server.tool(
    "adopt",
    "Adopt an existing hcom agent into managed lifecycle. Creates an adopted registry record for an agent that was not spawned by hcom-mcp, enabling stop/kill management. Requires the agent to be live in hcom. By default the adoptee is notified via an hcom inform message; pass silent=true to suppress.",
    {
      name: z.string().describe("hcom agent name to adopt"),
      workspace: z.string().optional().describe("Workspace path for registry"),
      sender_name: z.string().optional().describe("Sender identity used for hub self-protection. Required for HTTP or unbound MCP callers when auto-resolution is unavailable."),
      silent: z.boolean().optional().describe("Suppress the adoption notice to the adoptee (default: false)."),
    },
    async ({ name, workspace, sender_name, silent }: { name: string; workspace?: string; sender_name?: string; silent?: boolean }) => {
      const cwd = workspace ?? process.cwd();

      try {
        // Resolve caller name for hub self-protection
        const caller = await resolveCallerName(sender_name);
        if (!caller) {
          return {
            content: [{
              type: "text" as const,
              text: "Error: Cannot resolve sender identity. For HTTP or unbound MCP callers, provide the sender_name parameter explicitly. Bound hcom sessions may auto-resolve via 'hcom list self'.",
            }],
            isError: true,
          };
        }

        // Verify agent exists in hcom
        const allAgents = await listHcomAgents();
        const liveAgent = findLiveAgentByIdentifier(name, allAgents);
        if (!liveAgent) {
          return {
            content: [{ type: "text" as const, text: `Agent "${name}" not found in hcom` }],
            isError: true,
          };
        }

        // Hub self-protection: cannot adopt the calling hub agent
        if (caller && caller === name) {
          return {
            content: [{ type: "text" as const, text: "Cannot adopt the calling hub agent" }],
            isError: true,
          };
        }

        // Idempotency: check if record already exists and is not released
        const existing = findRecordByWorkspaceAndName(cwd, name);
        if (existing) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify(existing, null, 2),
            }],
          };
        }

        // Infer harness from the live agent's tool
        const harness = inferHarnessFromTool(liveAgent.tool);
        if (!harness) {
          return {
            content: [{
              type: "text" as const,
              text: `Cannot adopt agent with unknown harness "${liveAgent.tool ?? "undefined"}"`,
            }],
            isError: true,
          };
        }

        // Create adopted record
        const record = adoptRecord({
          workspace: cwd,
          harness,
          hcomName: name,
          sessionId: liveAgent.session_id,
        });

        // ponytail: one-shot inform, not a thread; upgrade to thread if durability needed
        let notify: { delivered: boolean; error?: string } | undefined;
        if (!silent) {
          const text = defaultAdoptNotice(caller, name, harness, cwd);
          const r = await execHcom(["send", `@${name}`, "--name", caller, "--intent", "inform", "--", text]);
          notify = { delivered: r.exitCode === 0, ...(r.exitCode !== 0 && { error: r.stderr || r.stdout }) };
        }

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ ...record, notify }, null, 2),
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
