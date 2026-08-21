import { z } from "zod";
import { execHcom, resolveCallerName, listHcomAgents, findLiveAgentByIdentifier, inferHarnessFromTool } from "../hcom.js";
import { adoptRecord, findRecordByWorkspaceAndName } from "../registry.js";
import type { Harness } from "../types.js";
import {
  E_AGENT_NOT_FOUND,
  E_NO_SENDER,
  E_SELF_PROTECTION,
  E_UNKNOWN_HARNESS,
  internalError,
  toolError,
} from "../errors.js";

function defaultAdoptNotice(hub: string, name: string, harness: Harness, workspace: string): string {
  return [
    "You have been adopted into hcom-mcp managed lifecycle.",
    `hub: ${hub}  your name: ${name}  harness: ${harness}  workspace: ${workspace}`,
    `Stop/kill commands from ${hub} are now authoritative for your session.`,
    "Your system prompt and task are unchanged.",
    `Load the "using-hcom" skill so you can correctly route hcom messages and acks.`,
    `Acknowledge this adoption by replying: "Ready, ${hub} is hub"`,
  ].join("\n");
}

export function registerAdoptTool(server: any) {
  server.tool(
    "adopt",
    "Adopt one or more live hcom agents not spawned by hcom-mcp into managed lifecycle, enabling stop/kill. Sends each adoptee an hcom inform with adoption instructions. Returns adopted records and per-name skips. Preconditions: sender identity (see sender_name); cannot adopt the calling hub itself (E_SELF_PROTECTION). Related: list_all (find unmanaged agents), stop/kill (now permitted).",
    {
      names: z.array(z.string()).min(1).describe("hcom agent names to adopt (one or more)"),
      workspace: z.string().optional().describe("Workspace path for registry. Defaults to the server's working directory. Pass explicitly when the server runs under a service manager (its cwd is the service home, not your workspace) so the record is scoped to the workspace you query with list_managed."),
      sender_name: z.string().optional().describe("Sender identity used for hub self-protection. REQUIRED for HTTP or unbound MCP callers: auto-resolution via 'hcom list self' never succeeds there, and the call fails with E_NO_SENDER. Bound hcom sessions may omit it."),
      notice: z.string().optional().describe("Custom adoption notice text. Defaults to the standard notice (hub, name, harness, workspace, using-hcom skill instruction)."),
    },
    async ({ names, workspace, sender_name, notice }: { names: string[]; workspace?: string; sender_name?: string; notice?: string }) => {
      const cwd = workspace ?? process.cwd();

      try {
        // Resolve caller name for hub self-protection
        const caller = await resolveCallerName(sender_name);
        if (!caller) {
          return toolError(
            E_NO_SENDER,
            "Cannot resolve sender identity. For HTTP or unbound MCP callers, provide the sender_name parameter explicitly. Bound hcom sessions may auto-resolve via 'hcom list self'.",
          );
        }

        const allAgents = await listHcomAgents();
        const adopted: Record<string, unknown>[] = [];
        const skipped: string[] = [];

        for (const name of names) {
          // Verify agent exists in hcom, canonicalizing the incoming name to
          // the live agent's base form. The registry stores base names, so the
          // idempotency lookup and the record write must use the canonical form
          // or adopting the same agent via either name form creates duplicates.
          const liveAgent = findLiveAgentByIdentifier(name, allAgents);
          if (!liveAgent) {
            skipped.push(`[${E_AGENT_NOT_FOUND}] Agent "${name}" not found in hcom`);
            continue;
          }
          const canonicalName = liveAgent.base_name;

          // Hub self-protection: cannot adopt the calling hub agent. Compare
          // against the canonical base name AND the live display name so a hub
          // adopting its own tag-prefixed form is refused exactly like its bare
          // form.
          if (caller === canonicalName || caller === liveAgent.name) {
            skipped.push(`[${E_SELF_PROTECTION}] Cannot adopt the calling hub agent "${name}"`);
            continue;
          }

          // Idempotency: check if record already exists and is not released
          const existing = findRecordByWorkspaceAndName(cwd, canonicalName);
          if (existing) {
            adopted.push(existing);
            continue;
          }

          // Infer harness from the live agent's tool
          const harness = inferHarnessFromTool(liveAgent.tool);
          if (!harness) {
            skipped.push(`[${E_UNKNOWN_HARNESS}] Cannot adopt agent "${name}" with unknown harness "${liveAgent.tool ?? "undefined"}"`);
            continue;
          }

          // Create adopted record
          const record = adoptRecord({
            workspace: cwd,
            harness,
            hcomName: canonicalName,
            sessionId: liveAgent.session_id,
            // No launchedBy: manual adopts are never supervised (#33/#37).
            launchMode: liveAgent.headless === false ? "headed" : "headless",
          });

          // ponytail: one-shot inform, not a thread; upgrade to thread if durability needed
          const text = notice ?? defaultAdoptNotice(caller, canonicalName, harness, cwd);
          const r = await execHcom(["send", `@${canonicalName}`, "--name", caller, "--intent", "inform", "--", text]);
          const notify = { delivered: r.exitCode === 0, ...(r.exitCode !== 0 && { error: r.stderr || r.stdout }) };

          adopted.push({ ...record, notify });
        }

        if (adopted.length === 0) {
          return toolError(E_AGENT_NOT_FOUND, skipped.join("\n"));
        }

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ adopted, skipped, total: adopted.length }, null, 2),
          }],
        };
      } catch (err: any) {
        return internalError(err);
      }
    },
  );
}
