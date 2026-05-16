import { z } from "zod";
import { findLiveAgentByIdentifier, listHcomAgents } from "../hcom.js";
import {
  getConfigPaths,
  loadMergedConfig,
  summarizeAgentPresets,
  summarizeTopologyPresets,
} from "../config.js";
import {
  getOwnedRecordsByWorkspace,
  getRecordsByWorkspace,
  updateRecordState,
} from "../registry.js";
import type { HcomAgent, RegistryRecord } from "../types.js";

export function matchLiveAgent(
  record: Pick<RegistryRecord, "hcomName">,
  hcomAgents: HcomAgent[]
): HcomAgent | null {
  if (!record.hcomName) {
    return null;
  }

  return findLiveAgentByIdentifier(record.hcomName, hcomAgents);
}

export function reconcileManagedRecords(
  records: RegistryRecord[],
  hcomAgents: HcomAgent[]
): RegistryRecord[] {
  return records.map((record) => {
    if (record.released || !record.hcomName) {
      return record;
    }

    if (record.state === "managed_lost" || record.state === "managed_stopped") {
      return record;
    }

    return matchLiveAgent(record, hcomAgents)
      ? record
      : { ...record, state: "managed_lost" as const };
  });
}

function persistReconciledState(before: RegistryRecord[], after: RegistryRecord[]) {
  for (const [index, record] of after.entries()) {
    if (record.state !== before[index]?.state) {
      updateRecordState(record.id, record.state);
    }
  }
}

function enrichManagedRecord(record: RegistryRecord, hcomAgents: HcomAgent[]) {
  const liveAgent = matchLiveAgent(record, hcomAgents);
  return {
    ...record,
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
      workspace: z.string().optional().describe("Workspace path"),
    },
    async ({ workspace }: { workspace?: string }) => {
      const cwd = workspace ?? process.cwd();

      try {
        const records = getOwnedRecordsByWorkspace(cwd);
        const hcomAgents = await listHcomAgents();
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
    {},
    async () => {
      try {
        const agents = await listHcomAgents();
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ agents, total: agents.length }, null, 2) }],
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
      workspace: z.string().optional().describe("Workspace path"),
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
      workspace: z.string().optional().describe("Workspace path"),
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
      workspace: z.string().optional().describe("Workspace path"),
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
    "Show a quick health and orientation summary for hcom-mcp",
    {
      workspace: z.string().optional().describe("Workspace path"),
    },
    async ({ workspace }: { workspace?: string }) => {
      const cwd = workspace ?? process.cwd();

      try {
        const config = loadMergedConfig(cwd);
        const paths = getConfigPaths(cwd);
        const liveAgents = await listHcomAgents();
        const workspaceRecords = getRecordsByWorkspace(cwd);
        const ownedRecords = getOwnedRecordsByWorkspace(cwd);
        const reconciled = reconcileManagedRecords(ownedRecords, liveAgents);
        persistReconciledState(ownedRecords, reconciled);

        const summary = {
          hcomAvailable: true,
          workspace: cwd,
          paths,
          agentPresetCount: Object.keys(config.agentPresets).length,
          topologyPresetCount: Object.keys(config.topologyPresets).length,
          liveAgentCount: liveAgents.length,
          managedRecordCount: reconciled.length,
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
