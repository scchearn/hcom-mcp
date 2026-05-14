import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  GlobalConfigSchema,
  WorkspaceConfigSchema,
  MergedConfigSchema,
  type MergedConfig,
  type GlobalConfig,
  type WorkspaceConfig,
} from "./types.js";

const GLOBAL_CONFIG_DIR = join(homedir(), ".hcom", "mcp");
const GLOBAL_CONFIG_PATH = join(GLOBAL_CONFIG_DIR, "config.json");
const WORKSPACE_CONFIG_FILENAME = ".hcom-mcp.json";

/**
 * Load and validate the global config from ~/.hcom/mcp/config.json
 */
export function loadGlobalConfig(cwd: string): GlobalConfig {
  let globalConfig: GlobalConfig = { agentPresets: {}, topologyPresets: {} };

  if (existsSync(GLOBAL_CONFIG_PATH)) {
    try {
      const raw = readFileSync(GLOBAL_CONFIG_PATH, "utf-8");
      const parsed = JSON.parse(raw);
      globalConfig = GlobalConfigSchema.parse(parsed);
    } catch (err: any) {
      throw new Error(
        `Failed to load global config from ${GLOBAL_CONFIG_PATH}: ${err.message}`
      );
    }
  }

  return globalConfig;
}

/**
 * Load and validate the workspace-local config overlay from .hcom-mcp.json in cwd
 */
export function loadWorkspaceConfig(cwd: string): WorkspaceConfig | null {
  const workspaceConfigPath = join(cwd, WORKSPACE_CONFIG_FILENAME);

  if (!existsSync(workspaceConfigPath)) {
    return null;
  }

  try {
    const raw = readFileSync(workspaceConfigPath, "utf-8");
    const parsed = JSON.parse(raw);
    return WorkspaceConfigSchema.parse(parsed);
  } catch (err: any) {
    throw new Error(
      `Failed to load workspace config from ${workspaceConfigPath}: ${err.message}`
    );
  }
}

/**
 * Merge global and workspace configs. Workspace overlays take precedence
 * for any preset or topology with the same key.
 */
export function mergeConfigs(
  global: GlobalConfig,
  workspace: WorkspaceConfig | null
): MergedConfig {
  if (!workspace) {
    return MergedConfigSchema.parse(global);
  }

  return MergedConfigSchema.parse({
    agentPresets: {
      ...global.agentPresets,
      ...(workspace.agentPresets ?? {}),
    },
    topologyPresets: {
      ...global.topologyPresets,
      ...(workspace.topologyPresets ?? {}),
    },
  });
}

/**
 * Load merged config for a given working directory.
 * This is the main entry point for config loading.
 */
export function loadMergedConfig(cwd: string): MergedConfig {
  const global = loadGlobalConfig(cwd);
  const workspace = loadWorkspaceConfig(cwd);
  return mergeConfigs(global, workspace);
}

/**
 * Resolve an agent preset by name, returning null if not found.
 */
export function resolveAgentPreset(
  config: MergedConfig,
  presetName: string
) {
  return config.agentPresets[presetName] ?? null;
}

/**
 * Resolve a topology preset by name, returning null if not found.
 */
export function resolveTopologyPreset(
  config: MergedConfig,
  presetName: string
) {
  return config.topologyPresets[presetName] ?? null;
}

/**
 * Validate that all topology roles reference existing agent presets.
 * Returns an array of error messages (empty if valid).
 */
export function validateTopologyReferences(
  config: MergedConfig,
  topologyName: string
): string[] {
  const errors: string[] = [];
  const topology = config.topologyPresets[topologyName];
  if (!topology) {
    errors.push(`Topology preset "${topologyName}" not found`);
    return errors;
  }

  for (const role of topology.roles) {
    if (!config.agentPresets[role.preset]) {
      errors.push(
        `Role "${role.role}" references agent preset "${role.preset}" which does not exist`
      );
    }
  }

  return errors;
}