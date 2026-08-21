import { z } from "zod";
import { execHcom, findLiveAgentByIdentifier, listHcomAgents, parseHcomJson, resolveCallerName } from "../hcom.js";
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
  reconcileGlobalRecords,
  reconcileManagedRecords,
  resolveRootLauncher,
} from "../registry.js";
import type { HcomAgent, RegistryRecord } from "../types.js";
import { E_INTERNAL, internalError } from "../errors.js";

export function enrichManagedRecord(
  record: RegistryRecord,
  hcomAgents: HcomAgent[],
  options: { caller?: string; records?: RegistryRecord[] } = {},
) {
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

  // Provenance (#33 follow-up): whose lane this agent belongs to. foreign
  // is true when the launcher is not the calling hub — a distinct field,
  // never silently mixed into the caller's own fleet.
  const rootLaunchedBy =
    resolveRootLauncher(record, options.records ?? [record]) ?? record.launchedBy ?? null;
  const foreign = Boolean(options.caller && record.launchedBy && record.launchedBy !== options.caller);

  return {
    ...record,
    launchedBy: record.launchedBy ?? null,
    rootLaunchedBy,
    foreign,
    managementType,
    liveFound: Boolean(liveAgent),
    liveName: liveAgent?.name ?? null,
    liveBaseName: liveAgent?.base_name ?? null,
    liveStatus: liveAgent?.status ?? null,
    liveDescription: liveAgent?.description ?? null,
    liveTool: liveAgent?.tool ?? null,
    liveTag: liveAgent?.tag ?? null,
    reportEvidence: {
      required: Boolean(record.requireReport),
      ...(record.dispatchAt ? { dispatchAt: record.dispatchAt } : {}),
    },
  };
}

export function registerListManagedTool(server: any) {
  server.tool(
    "list_managed",
    "List all hcom agents managed by this server in the current workspace, each record enriched with its live status and launch provenance (launchedBy/rootLaunchedBy/foreign flags the records whose launcher is not the calling hub). Read-only; no sender identity required. Related: list_all (all live agents), status (counts + health).",
    {
      workspace: z.string().optional().describe("Workspace path. Defaults to the server's working directory. Pass explicitly when the server runs under a service manager (its cwd is the service home, not your workspace) so records are scoped to the workspace you query with list_managed."),
      sender_name: z.string().optional().describe("Caller identity used to flag foreign-launched records. Optional: bound hcom sessions may auto-resolve via 'hcom list self'; without it the foreign flag stays false."),
    },
    async ({ workspace, sender_name }: { workspace?: string; sender_name?: string }) => {
      const cwd = workspace ?? process.cwd();

      try {
        const hcomAgents = await listHcomAgents();
        const records = getOwnedRecordsByWorkspace(cwd);
        const reconciled = reconcileManagedRecords(records, hcomAgents);
        persistReconciledState(records, reconciled);

        // Caller is resolved tolerantly: unbound callers still get the full
        // list, just without foreign flagging.
        const caller = await resolveCallerName(sender_name);
        const managed = reconciled.map((record) =>
          enrichManagedRecord(record, hcomAgents, { caller, records }),
        );

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ managed, total: managed.length }, null, 2),
          }],
        };
      } catch (err: any) {
        return internalError(err);
      }
    }
  );
}

export function registerListAllTool(server: any) {
  server.tool(
    "list_all",
    "List all live hcom agents visible to the local hcom CLI, each carrying its management status (managed/adopted/unmanaged) for the requested workspace. Read-only; no sender identity required. Related: list_managed (owned records only), inspect (per-agent detail).",
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
        return internalError(err);
      }
    }
  );
}

export function registerListPresetsTool(server: any) {
  server.tool(
    "list_presets",
    "List merged agent presets available to this server in the current workspace, with each preset's harnesses, models, and flags (and a promptPreview when prompt_preview=true). Read-only; no sender identity required. Related: launch (consumes presets), list_topologies.",
    {
      workspace: z.string().optional().describe("Workspace path. Defaults to the server's working directory. Pass explicitly when the server runs under a service manager (its cwd is the service home, not your workspace) so records are scoped to the workspace you query with list_managed."),
      prompt_preview: z.boolean().optional().describe("Include a promptPreview (first 120 chars) per preset (default: false)"),
    },
    async ({ workspace, prompt_preview }: { workspace?: string; prompt_preview?: boolean }) => {
      const cwd = workspace ?? process.cwd();

      try {
        const config = loadMergedConfig(cwd);
        const presets = summarizeAgentPresets(config.agentPresets, prompt_preview ?? false);
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ presets, total: presets.length }, null, 2) }],
        };
      } catch (err: any) {
        return internalError(err);
      }
    }
  );
}

export function registerListTopologiesTool(server: any) {
  server.tool(
    "list_topologies",
    "List merged topology presets available to this server in the current workspace, each with its roles, hub, thread prefix, and any missing presets. Read-only; no sender identity required. Related: launch_topology (consumes topologies), list_presets.",
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
        return internalError(err);
      }
    }
  );
}

export function registerStatusTool(server: any) {
  server.tool(
    "status",
    "Quick health and orientation summary for hcom-mcp, including hcom CLI install health — surfaced here because hook/install breakage stays invisible until launches die. Runs one global registry reconcile (persists state transitions across every workspace) and reports its evidence; no sender identity required. Related: list_managed, list_all, list_presets.",
    {
      workspace: z.string().optional().describe("Workspace path. Defaults to the server's working directory. Pass explicitly when the server runs under a service manager (its cwd is the service home, not your workspace) so records are scoped to the workspace you query with list_managed."),
    },
    async ({ workspace }: { workspace?: string }) => {
      const cwd = workspace ?? process.cwd();

      try {
        const config = loadMergedConfig(cwd);
        const paths = getConfigPaths(cwd);
        const workspaceRecords = getRecordsByWorkspace(cwd);
        // Global reconcile heals every workspace in one pass — records
        // stranded in dead worktree workspaces used to stay managed_active
        // forever because no tool call ever targeted those workspaces. The
        // workspace view is filtered out of the same reconciled set, and the
        // live snapshot comes from the SAME fetch so liveAgentCount can never
        // disagree with the stateBreakdown in this payload.
        const {
          records: reconciledAll,
          transitions,
          liveAgents,
        } = await reconcileGlobalRecords();
        const reconciled = reconciledAll.filter((record) => record.workspace === cwd);

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
          // Global reconcile evidence: how many non-released owned records
          // exist across ALL workspaces (released excluded, adopted
          // included) and which states the pass just corrected.
          globalOwnedRecordCount: reconciledAll.length,
          globalReconcileTransitions: transitions,
          managedLostCount: reconciled.filter((record) => record.state === "managed_lost").length,
          managedReleasedCount: workspaceRecords.filter((record) => record.released).length,
          // Provenance (#33 follow-up): who launched what in this workspace.
          // Unattributed records (legacy/adopted) group under "(unattributed)".
          byLauncher: reconciled.reduce<Record<string, number>>((acc, record) => {
            const key = record.launchedBy ?? "(unattributed)";
            acc[key] = (acc[key] ?? 0) + 1;
            return acc;
          }, {}),
          reportEvidence: reconciled
            .filter((record) => record.requireReport)
            .map((record) => ({
              id: record.id,
              hcomName: record.hcomName,
              state: record.state,
              launchedBy: record.launchedBy ?? null,
              dispatchAt: record.dispatchAt ?? null,
            })),
        };

        return {
          content: [{ type: "text" as const, text: JSON.stringify(summary, null, 2) }],
        };
      } catch (err: any) {
        return internalError(err);
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
