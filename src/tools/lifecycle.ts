import { z } from "zod";
import { execHcom, findLiveAgentByIdentifier, listHcomAgents, resolveCallerName } from "../hcom.js";
import { getOwnedRecordsByWorkspace, updateRecordState } from "../registry.js";
import type { RegistryRecord, HcomAgent } from "../types.js";

function formatManagedNames(names: Array<string | undefined>) {
  const filtered = names.filter(Boolean);
  return filtered.length > 0 ? filtered.join(", ") : "none";
}

/**
 * Shared validation for stop/kill targets:
 * 1. Hub self-protection — prevents stopping/killing the calling hub agent
 * 2. Ownership check — agent must have a non-released record in this workspace
 */
async function validateStopKillTarget(
  name: string,
  action: "stop" | "kill",
  senderName?: string,
  workspace?: string,
): Promise<
  | { ok: true; cwd: string; owned: RegistryRecord; liveAgent: HcomAgent | null }
  | { ok: false; response: { content: { type: "text"; text: string }[]; isError: true } }
> {
  const cwd = workspace ?? process.cwd();

  // Hub self-protection
  const caller = await resolveCallerName(senderName);
  if (!caller) {
    return {
      ok: false,
      response: {
        content: [{
          type: "text" as const,
          text: "Error: Cannot resolve sender identity. For HTTP or unbound MCP callers, provide the sender_name parameter explicitly. Bound hcom sessions may auto-resolve via 'hcom list self'.",
        }],
        isError: true,
      },
    };
  }
  if (caller === name) {
    return {
      ok: false,
      response: {
        content: [{ type: "text" as const, text: `Cannot ${action} the calling hub agent` }],
        isError: true,
      },
    };
  }

  // Ownership check
  const records = getOwnedRecordsByWorkspace(cwd);
  const owned = records.find((r) => r.hcomName === name);
  const liveAgents = await listHcomAgents();
  const liveAgent = findLiveAgentByIdentifier(name, liveAgents);

  if (!owned) {
    return {
      ok: false,
      response: {
        content: [
          {
            type: "text" as const,
            text: liveAgent
              ? `Agent "${name}" is not managed. Use adopt tool first to take ownership.`
              : `Agent "${name}" not found in hcom.`,
          },
        ],
        isError: true,
      },
    };
  }

  return { ok: true, cwd, owned, liveAgent };
}

export function registerLifecycleTools(server: any) {
  // stop
  server.tool(
    "stop",
    "Stop (disconnect) a managed or adopted agent",
    {
      name: z.string().describe("hcom agent name"),
      workspace: z.string().optional().describe("Workspace path"),
      sender_name: z.string().optional().describe("Sender identity used for hub self-protection. Required for HTTP or unbound MCP callers when auto-resolution is unavailable."),
    },
    async ({ name, workspace, sender_name }: { name: string; workspace?: string; sender_name?: string }) => {
      const validation = await validateStopKillTarget(name, "stop", sender_name, workspace);
      if (!validation.ok) return validation.response;

      const { cwd, owned, liveAgent } = validation;

      // Stale record check (covers both managed_lost and adopted_lost)
      const isLost = owned.state === "managed_lost" || owned.state === "adopted_lost";
      if (isLost && !liveAgent) {
        return {
          content: [{
            type: "text" as const,
            text: `Error: Agent "${name}" has a stale record in workspace "${cwd}" but is no longer live in hcom.`,
          }],
          isError: true,
        };
      }

      const result = await execHcom(["stop", name]);
      if (result.exitCode !== 0) {
        if ((result.stderr || result.stdout).toLowerCase().includes("not found")) {
          const lostState = owned.state.startsWith("adopted_") ? "adopted_lost" : "managed_lost";
          updateRecordState(owned.id, lostState);
          return {
            content: [{
              type: "text" as const,
              text: `Error: Agent "${name}" is no longer live in hcom. Its record was marked ${lostState}.`,
            }],
            isError: true,
          };
        }

        return {
          content: [{ type: "text" as const, text: `Error stopping agent: ${result.stderr || result.stdout}` }],
          isError: true,
        };
      }

      // State transition: adopted → adopted_stopped, managed → managed_stopped
      const newState = owned.state.startsWith("adopted_") ? "adopted_stopped" : "managed_stopped";
      updateRecordState(owned.id, newState);

      const adoptedLabel = owned.state.startsWith("adopted_") ? " (adopted agent)" : "";
      return {
        content: [{ type: "text" as const, text: `Stopped agent "${name}".${adoptedLabel}` }],
      };
    }
  );

  // kill
  server.tool(
    "kill",
    "Kill a managed or adopted agent and close its terminal pane",
    {
      name: z.string().describe("hcom agent name"),
      workspace: z.string().optional().describe("Workspace path"),
      sender_name: z.string().optional().describe("Sender identity used for hub self-protection. Required for HTTP or unbound MCP callers when auto-resolution is unavailable."),
    },
    async ({ name, workspace, sender_name }: { name: string; workspace?: string; sender_name?: string }) => {
      const validation = await validateStopKillTarget(name, "kill", sender_name, workspace);
      if (!validation.ok) return validation.response;

      const { cwd, owned, liveAgent } = validation;

      const isLost = owned.state === "managed_lost" || owned.state === "adopted_lost";
      if (isLost && !liveAgent) {
        return {
          content: [{
            type: "text" as const,
            text: `Error: Agent "${name}" has a stale record in workspace "${cwd}" but is no longer live in hcom.`,
          }],
          isError: true,
        };
      }

      const result = await execHcom(["kill", name, "--go"]);
      if (result.exitCode !== 0) {
        if ((result.stderr || result.stdout).toLowerCase().includes("not found")) {
          const lostState = owned.state.startsWith("adopted_") ? "adopted_lost" : "managed_lost";
          updateRecordState(owned.id, lostState);
          return {
            content: [{
              type: "text" as const,
              text: `Error: Agent "${name}" is no longer live in hcom. Its record was marked ${lostState}.`,
            }],
            isError: true,
          };
        }

        return {
          content: [{ type: "text" as const, text: `Error killing agent: ${result.stderr || result.stdout}` }],
          isError: true,
        };
      }

      const newState = owned.state.startsWith("adopted_") ? "adopted_stopped" : "managed_stopped";
      updateRecordState(owned.id, newState);

      const adoptedLabel = owned.state.startsWith("adopted_") ? " (adopted agent)" : "";
      return {
        content: [{ type: "text" as const, text: `Killed agent "${name}".${adoptedLabel}` }],
      };
    }
  );
}
