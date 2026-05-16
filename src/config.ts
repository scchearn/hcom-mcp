import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { REGISTRY_PATH } from "./registry.js";
import {
  AgentPresetSchema,
  GlobalConfigSchema,
  GlobalConfigInputSchema,
  WorkspaceConfigSchema,
  WorkspaceConfigInputSchema,
  MergedConfigSchema,
  type MergedConfig,
  type GlobalConfig,
  type GlobalConfigInput,
  type WorkspaceConfig,
  type WorkspaceConfigInput,
  type AgentPreset,
  type AgentPresetInput,
} from "./types.js";

const GLOBAL_CONFIG_DIR = join(homedir(), ".hcom", "mcp");
export const GLOBAL_CONFIG_PATH = join(GLOBAL_CONFIG_DIR, "config.json");
export const WORKSPACE_CONFIG_FILENAME = ".hcom-mcp.json";

/**
 * Load and validate the global config from ~/.hcom/mcp/config.json
 */
function normalizeAgentPreset(preset: AgentPresetInput): AgentPreset {
  if (typeof preset.harness === "string") {
    return AgentPresetSchema.parse({
      name: preset.name,
      harness: {
        [preset.harness]: {
          model: preset.model,
        },
      },
      headless: preset.headless,
      pty: preset.pty,
      tag: preset.tag,
      dir: preset.dir,
      prompt: preset.prompt,
      systemPrompt: preset.systemPrompt,
    });
  }

  return AgentPresetSchema.parse(preset);
}

function normalizeAgentPresets(presets: Record<string, AgentPresetInput> = {}) {
  return Object.fromEntries(
    Object.entries(presets).map(([name, preset]) => [name, normalizeAgentPreset(preset)])
  );
}

function normalizeGlobalConfig(input: GlobalConfigInput): GlobalConfig {
  return GlobalConfigSchema.parse({
    agentPresets: normalizeAgentPresets(input.agentPresets),
    topologyPresets: input.topologyPresets,
  });
}

function normalizeWorkspaceConfig(input: WorkspaceConfigInput): WorkspaceConfig {
  return WorkspaceConfigSchema.parse({
    agentPresets: input.agentPresets ? normalizeAgentPresets(input.agentPresets) : undefined,
    topologyPresets: input.topologyPresets,
  });
}

export function loadGlobalConfig(cwd: string): GlobalConfig {
  let globalConfig: GlobalConfig = { agentPresets: {}, topologyPresets: {} };

  if (existsSync(GLOBAL_CONFIG_PATH)) {
    try {
      const raw = readFileSync(GLOBAL_CONFIG_PATH, "utf-8");
      const parsed = JSON.parse(raw);
      globalConfig = normalizeGlobalConfig(GlobalConfigInputSchema.parse(parsed));
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
    return normalizeWorkspaceConfig(WorkspaceConfigInputSchema.parse(parsed));
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

export function getConfigPaths(cwd: string) {
  const workspaceConfigPath = join(cwd, WORKSPACE_CONFIG_FILENAME);

  return {
    globalConfig: {
      path: GLOBAL_CONFIG_PATH,
      exists: existsSync(GLOBAL_CONFIG_PATH),
    },
    workspaceConfig: {
      path: workspaceConfigPath,
      exists: existsSync(workspaceConfigPath),
    },
    registry: {
      path: REGISTRY_PATH,
      exists: existsSync(REGISTRY_PATH),
    },
  };
}

export function summarizeAgentPresets(
  presets: MergedConfig["agentPresets"]
) {
  return Object.values(presets)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((preset) => ({
      name: preset.name,
      supportedHarnesses: Object.keys(preset.harness)
        .filter((key) => Boolean(preset.harness[key as keyof typeof preset.harness]))
        .sort(),
      modelsByHarness: Object.fromEntries(
        Object.entries(preset.harness)
          .filter(([, variant]) => Boolean(variant))
          .map(([harness, variant]) => [harness, variant!.model])
      ),
      headless: preset.headless,
      pty: preset.pty,
      tag: preset.tag ?? null,
      hasDir: Boolean(preset.dir),
      hasPrompt: Boolean(preset.prompt),
      hasSystemPrompt: Boolean(preset.systemPrompt),
    }));
}

export function summarizeTopologyPresets(config: MergedConfig) {
  return Object.values(config.topologyPresets)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((topology) => ({
      name: topology.name,
      roleCount: topology.roles.length,
      roles: topology.roles.map((role) => ({
        role: role.role,
        preset: role.preset,
        harness: role.harness,
        count: role.count,
      })),
      hub: topology.hub ?? null,
      threadPrefix: topology.threadPrefix ?? null,
      missingPresets: topology.roles
        .filter((role) => !config.agentPresets[role.preset])
        .map((role) => role.preset),
    }));
}
