import { z } from "zod";
import { execHcom } from "../hcom.js";
import { getActiveRecords, updateRecordState, releaseRecord } from "../registry.js";

export function registerLifecycleTools(server: any) {
  // hcom_stop
  server.tool(
    "hcom_stop",
    "Stop (disconnect) a managed agent",
    {
      name: z.string().describe("hcom agent name"),
      workspace: z.string().optional().describe("Workspace path"),
    },
    async ({ name, workspace }: { name: string; workspace?: string }) => {
      const cwd = workspace ?? process.cwd();
      const records = getActiveRecords(cwd);
      const owned = records.find((r) => r.hcomName === name);

      if (!owned) {
        return {
          content: [{ type: "text" as const, text: `Error: Agent "${name}" is not managed by this server.` }],
          isError: true,
        };
      }

      const result = await execHcom(["stop", name]);
      if (result.exitCode !== 0) {
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

  // hcom_kill
  server.tool(
    "hcom_kill",
    "Kill a managed agent and close its terminal pane",
    {
      name: z.string().describe("hcom agent name"),
      workspace: z.string().optional().describe("Workspace path"),
    },
    async ({ name, workspace }: { name: string; workspace?: string }) => {
      const cwd = workspace ?? process.cwd();
      const records = getActiveRecords(cwd);
      const owned = records.find((r) => r.hcomName === name);

      if (!owned) {
        return {
          content: [{ type: "text" as const, text: `Error: Agent "${name}" is not managed by this server.` }],
          isError: true,
        };
      }

      const result = await execHcom(["kill", name, "--go"]);
      if (result.exitCode !== 0) {
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

  // hcom_promote
  server.tool(
    "hcom_promote",
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
      const records = getActiveRecords(cwd);
      const owned = records.find((r) => r.hcomName === name);

      if (!owned) {
        return {
          content: [{ type: "text" as const, text: `Error: Agent "${name}" is not managed by this server.` }],
          isError: true,
        };
      }

      // Resume the agent in a visible terminal
      const result = await execHcom(["r", name, "--go"]);
      if (result.exitCode !== 0) {
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