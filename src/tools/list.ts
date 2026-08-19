import { z } from "zod";
import { execHcom, findLiveAgentByIdentifier, listHcomAgents, parseHcomJson } from "../hcom.js";
import {
  getConfigPaths,
  loadMergedConfig,
  summarizeAgentPresets,
  summarizeTopologyPresets,
} from "../config.js";
import {
  getOwnedRecordsByWorkspace,
  getRecordsByWorkspace,
  matchLiveAgent,
  persistReconciledState,
  reconcileManagedRecords,
  reconcileWorkspaceRecords,
} from "../registry.js";
import type { HcomAgent, RegistryRecord } from "../types.js";

export function enrichManagedRecord(record: RegistryRecord, hcomAgents: HcomAgent[]) {
  const liveAgent = matchLiveAgent(record, hcomAgents);

  let managementType: string;
  if (
    record.state.startsWith("adopted_") ||
    record.preset === "adopted"
  ) {
    managementType = "adopted";
  } else if (record.state.startsWith("managed_")) {
    managementType = "managed";
  } else {
    managementType = "managed";
  }

  return {
    ...record,
    managementType,
    liveFound: Boolean(liveAgent),
    liveName: liveAgent?.name ?? null,
    liveBaseName: liveAgent?.base_name ?? null,
    liveStatus: liveAgent?.status ?? null,
    liveDescription: liveAgent?.description ?? null,
    liveTool: liveAgent?.tool ?? null,
    liveTag: liveAgent?.tag ?? null,
  };
}

export function registerListManagedTool(server: any) {
  server.tool(
    "list_managed",
    "List all hcom agents managed by this MCP server in the current workspace",
    {
      workspace: z.string().optional().describe("Workspace path. Defaults to the server's working directory. Pass explicitly when the server runs under a service manager (its cwd is the service home, not your workspace) so records are scoped to the workspace you query with list_managed."),
    },
    async ({ workspace }: { workspace?: string }) => {
      const cwd = workspace ?? process.cwd();

      try {
        const hcomAgents = await listHcomAgents();
        const records = getOwnedRecordsByWorkspace(cwd);
        const reconciled = reconcileManagedRecords(records, hcomAgents);
        persistReconciledState(records, reconciled);

        const managed = reconciled.map((record) => enrichManagedRecord(record, hcomAgents));

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ managed, total: managed.length }, null, 2),
          }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    }
  );
}

export function registerListAllTool(server: any) {
  server.tool(
    "list_all",
    "List all live hcom agents visible to the local hcom CLI",
    {
      workspace: z.string().optional().describe("Workspace path for ownership resolution. Defaults to the server's working directory. Pass explicitly when the server runs under a service manager (its cwd is the service home, not your workspace) so managementStatus matches the workspace you query with list_managed."),
    },
    async ({ workspace }: { workspace?: string }) => {
      try {
        const agents = await listHcomAgents();
        const cwd = workspace ?? process.cwd();
        const records = getOwnedRecordsByWorkspace(cwd);

        const agentsWithStatus = agents.map((agent) => {
          const record = records.find(
            (r) => r.hcomName === agent.name || r.hcomName === agent.base_name,
          );

          let managementStatus: string;
          if (!record) {
            managementStatus = "unmanaged";
          } else if (
            record.state.startsWith("adopted_") ||
            record.preset === "adopted"
          ) {
            managementStatus = "adopted";
          } else if (record.state.startsWith("managed_")) {
            managementStatus = "managed";
          } else {
            managementStatus = "unmanaged";
          }

          return { ...agent, managementStatus };
        });

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ agents: agentsWithStatus, total: agentsWithStatus.length }, null, 2),
          }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    }
  );
}

export function registerListPresetsTool(server: any) {
  server.tool(
    "list_presets",
    "List merged agent presets available to this server in the current workspace",
    {
      workspace: z.string().optional().describe("Workspace path. Defaults to the server's working directory. Pass explicitly when the server runs under a service manager (its cwd is the service home, not your workspace) so records are scoped to the workspace you query with list_managed."),
    },
    async ({ workspace }: { workspace?: string }) => {
      const cwd = workspace ?? process.cwd();

      try {
        const config = loadMergedConfig(cwd);
        const presets = summarizeAgentPresets(config.agentPresets);
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ presets, total: presets.length }, null, 2) }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    }
  );
}

export function registerListTopologiesTool(server: any) {
  server.tool(
    "list_topologies",
    "List merged topology presets available to this server in the current workspace",
    {
      workspace: z.string().optional().describe("Workspace path. Defaults to the server's working directory. Pass explicitly when the server runs under a service manager (its cwd is the service home, not your workspace) so records are scoped to the workspace you query with list_managed."),
    },
    async ({ workspace }: { workspace?: string }) => {
      const cwd = workspace ?? process.cwd();

      try {
        const config = loadMergedConfig(cwd);
        const topologies = summarizeTopologyPresets(config);
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ topologies, total: topologies.length }, null, 2) }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    }
  );
}

export function registerConfigPathsTool(server: any) {
  server.tool(
    "config_paths",
    "Show the config and registry paths used by this server",
    {
      workspace: z.string().optional().describe("Workspace path. Defaults to the server's working directory. Pass explicitly when the server runs under a service manager (its cwd is the service home, not your workspace) so records are scoped to the workspace you query with list_managed."),
    },
    async ({ workspace }: { workspace?: string }) => {
      const cwd = workspace ?? process.cwd();

      try {
        const paths = getConfigPaths(cwd);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(paths, null, 2) }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    }
  );
}

export function registerStatusTool(server: any) {
  server.tool(
    "status",
    "Show a quick health and orientation summary for hcom-mcp, including the hcom CLI installation health (hooks/install breakage is invisible until launches die, so it is surfaced here).",
    {
      workspace: z.string().optional().describe("Workspace path. Defaults to the server's working directory. Pass explicitly when the server runs under a service manager (its cwd is the service home, not your workspace) so records are scoped to the workspace you query with list_managed."),
    },
    async ({ workspace }: { workspace?: string }) => {
      const cwd = workspace ?? process.cwd();

      try {
        const config = loadMergedConfig(cwd);
        const paths = getConfigPaths(cwd);
        const liveAgents = await listHcomAgents();
        const workspaceRecords = getRecordsByWorkspace(cwd);
        const reconciled = await reconcileWorkspaceRecords(cwd);

        // Full state breakdown across every ownership state, including the
        // stale buckets (adopted_lost is the largest in the wild and was
        // invisible before). Built from the RECONCILED records so the
        // breakdown and the derived counts never disagree.
        const stateBreakdown: Record<string, number> = {};
        for (const record of reconciled) {
          stateBreakdown[record.state] = (stateBreakdown[record.state] ?? 0) + 1;
        }

        const summary = {
          hcomAvailable: true,
          hcomVersion: await getHcomVersion(),
          // #11.6: fold `hcom status --json` in so hook/install breakage is
          // visible before it eats a launch. Cached like the version check.
          hcomHealth: await getHcomHealth(),
          workspace: cwd,
          paths,
          agentPresetCount: Object.keys(config.agentPresets).length,
          topologyPresetCount: Object.keys(config.topologyPresets).length,
          liveAgentCount: liveAgents.length,
          managedRecordCount: reconciled.length,
          stateBreakdown,
          managedLostCount: reconciled.filter((record) => record.state === "managed_lost").length,
          managedReleasedCount: workspaceRecords.filter((record) => record.released).length,
        };

        return {
          content: [{ type: "text" as const, text: JSON.stringify(summary, null, 2) }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    }
  );
}

/**
 * Read the hcom CLI version via `hcom --version`. Returns null when the CLI
 * is missing or fails, so status stays informative instead of hard-coding
 * availability. Cached once per process: the version rarely changes within a
 * session and status is polled.
 */
let cachedHcomVersion: string | null | undefined;

async function getHcomVersion(): Promise<string | null> {
  if (cachedHcomVersion !== undefined) return cachedHcomVersion;
  const result = await execHcom(["--version"]);
  cachedHcomVersion = result.exitCode === 0 ? (result.stdout || null) : null;
  return cachedHcomVersion;
}

/**
 * Read `hcom status --json` for installation health (hooks, tools, relay,
 * config validity). Returns null when the CLI fails, so status stays
 * informative instead of hard-coding health. Cached once per process like
 * the version check: installation state changes rarely within a session.
 */
let cachedHcomHealth: Record<string, unknown> | null | undefined;

async function getHcomHealth(): Promise<Record<string, unknown> | null> {
  if (cachedHcomHealth !== undefined) return cachedHcomHealth;
  const result = await execHcom(["status", "--json"]);
  if (result.exitCode !== 0) {
    cachedHcomHealth = null;
    return null;
  }
  const parsed = parseHcomJson<Record<string, unknown>>(result.stdout);
  cachedHcomHealth = parsed ?? null;
  return cachedHcomHealth;
}
