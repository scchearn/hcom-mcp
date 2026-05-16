import { z } from "zod";
import { execHcom, findLiveAgentByIdentifier, listHcomAgents } from "../hcom.js";
import { getOwnedRecordsByWorkspace, updateRecordState, releaseRecord } from "../registry.js";

function formatManagedNames(names: Array<string | undefined>) {
  const filtered = names.filter(Boolean);
  return filtered.length > 0 ? filtered.join(", ") : "none";
}

export function registerLifecycleTools(server: any) {
  // stop
  server.tool(
    "stop",
    "Stop (disconnect) a managed agent",
    {
      name: z.string().describe("hcom agent name"),
      workspace: z.string().optional().describe("Workspace path"),
    },
    async ({ name, workspace }: { name: string; workspace?: string }) => {
      const cwd = workspace ?? process.cwd();
      const records = getOwnedRecordsByWorkspace(cwd);
      const owned = records.find((r) => r.hcomName === name);
      const liveAgents = await listHcomAgents();
      const liveAgent = findLiveAgentByIdentifier(name, liveAgents);

      if (!owned) {
        return {
          content: [{
            type: "text" as const,
            text: liveAgent
              ? `Error: Agent "${name}" exists in hcom as "${liveAgent.name}" but is not managed by this server in workspace "${cwd}". Managed agents: ${formatManagedNames(records.map((record) => record.hcomName))}`
              : `Error: Agent "${name}" was not found in the managed registry or live hcom for workspace "${cwd}". Managed agents: ${formatManagedNames(records.map((record) => record.hcomName))}`,
          }],
          isError: true,
        };
      }

      if (owned.state === "managed_lost" && !liveAgent) {
        return {
          content: [{
            type: "text" as const,
            text: `Error: Agent "${name}" has a stale managed record in workspace "${cwd}" but is no longer live in hcom.`,
          }],
          isError: true,
        };
      }

      const result = await execHcom(["stop", name]);
      if (result.exitCode !== 0) {
        if ((result.stderr || result.stdout).toLowerCase().includes("not found")) {
          updateRecordState(owned.id, "managed_lost");
          return {
            content: [{
              type: "text" as const,
              text: `Error: Agent "${name}" is no longer live in hcom. Its managed record was marked managed_lost.`,
            }],
            isError: true,
          };
        }

        return {
          content: [{ type: "text" as const, text: `Error stopping agent: ${result.stderr || result.stdout}` }],
          isError: true,
        };
      }

      updateRecordState(owned.id, "managed_stopped");
      return {
        content: [{ type: "text" as const, text: `Stopped agent "${name}".` }],
      };
    }
  );

  // kill
  server.tool(
    "kill",
    "Kill a managed agent and close its terminal pane",
    {
      name: z.string().describe("hcom agent name"),
      workspace: z.string().optional().describe("Workspace path"),
    },
    async ({ name, workspace }: { name: string; workspace?: string }) => {
      const cwd = workspace ?? process.cwd();
      const records = getOwnedRecordsByWorkspace(cwd);
      const owned = records.find((r) => r.hcomName === name);
      const liveAgents = await listHcomAgents();
      const liveAgent = findLiveAgentByIdentifier(name, liveAgents);

      if (!owned) {
        return {
          content: [{
            type: "text" as const,
            text: liveAgent
              ? `Error: Agent "${name}" exists in hcom as "${liveAgent.name}" but is not managed by this server in workspace "${cwd}". Managed agents: ${formatManagedNames(records.map((record) => record.hcomName))}`
              : `Error: Agent "${name}" was not found in the managed registry or live hcom for workspace "${cwd}". Managed agents: ${formatManagedNames(records.map((record) => record.hcomName))}`,
          }],
          isError: true,
        };
      }

      if (owned.state === "managed_lost" && !liveAgent) {
        return {
          content: [{
            type: "text" as const,
            text: `Error: Agent "${name}" has a stale managed record in workspace "${cwd}" but is no longer live in hcom.`,
          }],
          isError: true,
        };
      }

      const result = await execHcom(["kill", name, "--go"]);
      if (result.exitCode !== 0) {
        if ((result.stderr || result.stdout).toLowerCase().includes("not found")) {
          updateRecordState(owned.id, "managed_lost");
          return {
            content: [{
              type: "text" as const,
              text: `Error: Agent "${name}" is no longer live in hcom. Its managed record was marked managed_lost.`,
            }],
            isError: true,
          };
        }

        return {
          content: [{ type: "text" as const, text: `Error killing agent: ${result.stderr || result.stdout}` }],
          isError: true,
        };
      }

      updateRecordState(owned.id, "managed_stopped");
      return {
        content: [{ type: "text" as const, text: `Killed agent "${name}".` }],
      };
    }
  );

  // promote
  server.tool(
    "promote",
    "Promote a blocked headless agent to headed (visible terminal). Choose to retain management or release to human.",
    {
      name: z.string().describe("hcom agent name"),
      mode: z.enum(["keep-managed", "release-to-human"]).describe("Whether to keep MCP management or release ownership"),
      workspace: z.string().optional().describe("Workspace path"),
    },
    async ({ name, mode, workspace }: {
      name: string;
      mode: "keep-managed" | "release-to-human";
      workspace?: string;
    }) => {
      const cwd = workspace ?? process.cwd();
      const records = getOwnedRecordsByWorkspace(cwd);
      const owned = records.find((r) => r.hcomName === name);
      const liveAgents = await listHcomAgents();
      const liveAgent = findLiveAgentByIdentifier(name, liveAgents);

      if (!owned) {
        return {
          content: [{
            type: "text" as const,
            text: liveAgent
              ? `Error: Agent "${name}" exists in hcom as "${liveAgent.name}" but is not managed by this server in workspace "${cwd}". Managed agents: ${formatManagedNames(records.map((record) => record.hcomName))}`
              : `Error: Agent "${name}" was not found in the managed registry or live hcom for workspace "${cwd}". Managed agents: ${formatManagedNames(records.map((record) => record.hcomName))}`,
          }],
          isError: true,
        };
      }

      if (owned.state === "managed_lost" && !liveAgent) {
        return {
          content: [{
            type: "text" as const,
            text: `Error: Agent "${name}" has a stale managed record in workspace "${cwd}" but is no longer live in hcom.`,
          }],
          isError: true,
        };
      }

      // hcom r without --headless resumes in a visible terminal window (the user's
      // configured terminal preset). Omitting the flag is what provides the headed behavior.
      const result = await execHcom(["r", name, "--go"]);
      if (result.exitCode !== 0) {
        if ((result.stderr || result.stdout).toLowerCase().includes("not found")) {
          updateRecordState(owned.id, "managed_lost");
          return {
            content: [{
              type: "text" as const,
              text: `Error: Agent "${name}" is no longer live in hcom. Its managed record was marked managed_lost.`,
            }],
            isError: true,
          };
        }

        return {
          content: [{ type: "text" as const, text: `Error promoting agent: ${result.stderr || result.stdout}` }],
          isError: true,
        };
      }

      if (mode === "release-to-human") {
        releaseRecord(owned.id);
        return {
          content: [{
            type: "text" as const,
            text: `Agent "${name}" promoted to headed and released to human ownership.`,
          }],
        };
      }

      // Keep managed — just update state
      updateRecordState(owned.id, "managed_active");
      return {
        content: [{
          type: "text" as const,
          text: `Agent "${name}" promoted to headed. Management retained.`,
        }],
      };
    }
  );
}
