import { z } from "zod";
import { execHcom, listHarnessModels, resolveCallerName } from "../hcom.js";
import type { ExecOptions, ModelDiscoveryResult } from "../hcom.js";
import { loadMergedConfig, resolveAgentPreset, resolveTopologyPreset, validateTopologyReferences } from "../config.js";
import { addRecord, removeRecords } from "../registry.js";
import { HARNESS_COMMAND, HarnessEnum } from "../types.js";
import type { AgentPreset, Harness } from "../types.js";

type ModelCatalogCache = Map<Harness, ModelDiscoveryResult>;

type ResolvedLaunchPreset = {
  name: string;
  harness: Harness;
  model: string;
  headless: boolean;
  pty: boolean;
  tag?: string;
  dir?: string;
  prompt?: string;
  systemPrompt?: string;
  reasoning?: string;
};

type LaunchResult = {
  presetName: string;
  hcomNames: string[];
  batchId: string | null;
  registryId: string;
  registryIds: string[];
  command: string;
};

function defaultPromptForHarness(harness: Harness): string | undefined {
  if (harness === "claude") return "Wait for instructions from the hub.";
  return undefined;
}

function getSupportedHarnesses(preset: AgentPreset) {
  return Object.entries(preset.harness)
    .filter(([, variant]) => Boolean(variant))
    .map(([harness]) => harness)
    .sort();
}

function resolvePresetHarness(
  preset: AgentPreset,
  harness: Harness
): ResolvedLaunchPreset {
  const variant = preset.harness[harness];
  if (!variant) {
    throw new Error(
      `Preset "${preset.name}" does not support harness "${harness}". Supported: ${getSupportedHarnesses(preset).join(", ")}.`
    );
  }

  return {
    name: preset.name,
    harness,
    model: variant.model,
    headless: preset.headless,
    pty: preset.pty,
    tag: preset.tag,
    dir: preset.dir,
    prompt: preset.prompt,
    systemPrompt: preset.systemPrompt,
    reasoning: variant.reasoning,
  };
}

function matchesConfiguredModel(
  preset: Pick<ResolvedLaunchPreset, "harness" | "model">,
  catalog: ModelDiscoveryResult
) {
  if (catalog.models.includes(preset.model)) {
    return true;
  }

  if (preset.harness === "claude") {
    return catalog.models.includes(preset.model.replace(/\[1m\]$/, ""));
  }

  return false;
}

export async function validatePresetModelAvailability(
  preset: Pick<ResolvedLaunchPreset, "name" | "harness" | "model">,
  catalogCache: ModelCatalogCache = new Map()
): Promise<string | null> {
  let catalog = catalogCache.get(preset.harness);
  if (!catalog) {
    [catalog] = await listHarnessModels(preset.harness);
    catalogCache.set(preset.harness, catalog);
  }

  if (catalog.status === "error") {
    return `Could not verify model "${preset.model}" for preset "${preset.name}": ${catalog.reason ?? `failed to read the ${preset.harness} model catalog`}.`;
  }

  if (!matchesConfiguredModel(preset, catalog)) {
    return `Configured model "${preset.model}" for preset "${preset.name}" was not found in the ${catalog.status} ${preset.harness} model catalog. Use list_models to inspect available models.`;
  }

  return null;
}

/**
 * Register the launch tool for single-agent launch.
 */
export function registerLaunchTool(server: any) {
  server.tool(
    "launch",
    "Launch a headless hcom agent. Use a preset name for configured defaults, or provide harness+model directly for a bare launch. Preset defaults (model, tag, prompt) can be overridden with explicit parameters.",
    {
      harness: HarnessEnum.describe("Harness variant to launch (claude, opencode, codex)"),
      preset: z.string().optional().describe("Name of the agent preset from config (optional if model is provided)"),
      model: z.string().optional().describe("Model name override or standalone model for bare launches"),
      prompt: z.string().optional().describe("Initial prompt for the agent"),
      tag: z.string().optional().describe("Tag for the agent (defaults to harness name for bare launches)"),
      dir: z.string().optional().describe("Working directory override"),
      workspace: z.string().optional().describe("Workspace path for ownership tracking"),
      sender_name: z.string().optional().describe("Sender identity recorded as the launcher. Required for HTTP or unbound MCP callers when auto-resolution is unavailable."),
      reasoning: z.string().optional().describe("Reasoning effort level (opencode: --variant, claude: --effort, codex: ignored)"),
    },
    async ({ harness, preset: presetName, model, prompt, tag, dir, workspace, sender_name, reasoning }: {
      harness: Harness;
      preset?: string;
      model?: string;
      prompt?: string;
      tag?: string;
      dir?: string;
      workspace?: string;
      sender_name?: string;
      reasoning?: string;
    }) => {
      const cwd = workspace ?? process.cwd();

      try {
        const callerName = await resolveCallerName(sender_name);

        if (!callerName) {
          return {
            content: [{
              type: "text" as const,
              text: "Error: Cannot resolve sender identity. For HTTP or unbound MCP callers, provide the sender_name parameter explicitly. Bound hcom sessions may auto-resolve via 'hcom list self'.",
            }],
            isError: true,
          };
        }

        // Require at least preset or model
        if (!presetName && !model) {
          return {
            content: [{
              type: "text" as const,
              text: "Error: Provide at least a preset or a model. Use list_presets to see available presets, or specify harness + model for a bare launch.",
            }],
            isError: true,
          };
        }

        if (presetName) {
          // Preset path — current behavior plus model/tag overrides
          const config = loadMergedConfig(cwd);
          const preset = resolveAgentPreset(config, presetName);

          if (!preset) {
            return {
              content: [{
                type: "text" as const,
                text: `Error: Agent preset "${presetName}" not found. Available presets: ${Object.keys(config.agentPresets).join(", ")}. Use list_presets to inspect the merged preset catalog.`,
              }],
              isError: true,
            };
          }

          if (!harness) {
            return {
              content: [{
                type: "text" as const,
                text: `Error: Launch preset "${preset.name}" requires an explicit harness. Supported: ${getSupportedHarnesses(preset).join(", ")}.`,
              }],
              isError: true,
            };
          }

          const resolvedPreset = resolvePresetHarness(preset, harness);

          // Apply overrides
          if (model) {
            resolvedPreset.model = model;
          }
          if (tag) {
            resolvedPreset.tag = tag;
          }
          if (reasoning) {
            resolvedPreset.reasoning = reasoning;
          }

          // Resolve effective prompt upstream
          resolvedPreset.prompt = prompt ?? resolvedPreset.prompt ?? defaultPromptForHarness(harness);

          const result = await launchAgent(resolvedPreset, { dir: dir ?? resolvedPreset.dir }, cwd, new Map(), callerName);
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify(result, null, 2),
            }],
          };
        } else {
          // Bare launch path — no preset, harness + model required
          const resolvedPreset: ResolvedLaunchPreset = {
            name: "adhoc",
            harness,
            model: model!,
            headless: true,
            pty: false,
            tag: tag ?? harness,
            dir,
            prompt: prompt ?? defaultPromptForHarness(harness),
            systemPrompt: undefined,
            reasoning,
          };

          const result = await launchAgent(resolvedPreset, { dir }, cwd, new Map(), callerName);
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify(result, null, 2),
            }],
          };
        }
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
 * Register the launch_topology tool for multi-agent batch launch.
 */
export function registerTopologyLaunchTool(server: any) {
  server.tool(
    "launch_topology",
    "Launch multiple agents from a topology preset. Rolls back all if any fail.",
    {
      topology: z.string().describe("Name of the topology preset from config"),
      workspace: z.string().optional().describe("Workspace path for ownership tracking"),
      sender_name: z.string().optional().describe("Sender identity recorded as the launcher. Required for HTTP or unbound MCP callers when auto-resolution is unavailable."),
    },
    async ({ topology: topologyName, workspace, sender_name }: {
      topology: string;
      workspace?: string;
      sender_name?: string;
    }) => {
      const cwd = workspace ?? process.cwd();

      try {
        const callerName = await resolveCallerName(sender_name);
        if (!callerName) {
          return {
            content: [{
              type: "text" as const,
              text: "Error: Cannot resolve sender identity. For HTTP or unbound MCP callers, provide the sender_name parameter explicitly. Bound hcom sessions may auto-resolve via 'hcom list self'.",
            }],
            isError: true,
          };
        }
        const config = loadMergedConfig(cwd);
        const topology = resolveTopologyPreset(config, topologyName);

        if (!topology) {
          return {
            content: [{
              type: "text" as const,
              text: `Error: Topology preset "${topologyName}" not found. Available: ${Object.keys(config.topologyPresets).join(", ")}. Use list_topologies to inspect the merged topology catalog.`,
            }],
            isError: true,
          };
        }

        // Validate that all referenced presets exist
        const refErrors = validateTopologyReferences(config, topologyName);
        if (refErrors.length > 0) {
          return {
            content: [{
              type: "text" as const,
              text: `Error: Invalid topology references:\n${refErrors.join("\n")}`,
            }],
            isError: true,
          };
        }

        const modelCatalogCache: ModelCatalogCache = new Map();

        const resolvedRoles = topology.roles.flatMap((role) => {
          const preset = resolveAgentPreset(config, role.preset);
          if (!preset) {
            throw new Error(`Role "${role.role}" references missing preset "${role.preset}".`);
          }

          const resolved = resolvePresetHarness(
            {
              ...preset,
              tag: preset.tag ?? role.role,
            },
            role.harness,
          );

          return Array.from({ length: role.count }, () => ({ role, resolved }));
        });

        for (const { role, resolved } of resolvedRoles) {
          const validationError = await validatePresetModelAvailability(resolved, modelCatalogCache);
          if (validationError) {
            return {
              content: [{
                type: "text" as const,
                text: `Error: Failed to validate role "${role.role}" with preset "${role.preset}": ${validationError}`,
              }],
              isError: true,
            };
          }
        }

        // Launch agents one at a time, collecting results for rollback on failure
        const launched: LaunchResult[] = [];
        const registryIds: string[] = [];

        for (const { role, resolved } of resolvedRoles) {
          try {
            const result = await launchAgent(resolved, { prompt: resolved.prompt }, cwd, modelCatalogCache, callerName);
            launched.push(result);
            registryIds.push(...result.registryIds);
          } catch (err: any) {
            // Rollback all previously launched agents
            removeRecords(registryIds);
            for (const prev of launched) {
              for (const name of prev.hcomNames) {
                await execHcom(["kill", name, "--go"]);
              }
            }
            return {
              content: [{
                type: "text" as const,
                text: `Error: Failed to launch role "${role.role}" with preset "${role.preset}": ${err.message}. Rolled back ${launched.length} agents.`,
              }],
              isError: true,
            };
          }
        }

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              topology: topologyName,
              launched: launched,
              totalAgents: launched.reduce((sum, l) => sum + l.hcomNames.length, 0),
            }, null, 2),
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

/**
 * Build and execute an hcom launch command for a single agent preset.
 */
async function launchAgent(
  preset: ResolvedLaunchPreset,
  overrides: { prompt?: string; dir?: string },
  workspace: string,
  catalogCache: ModelCatalogCache = new Map(),
  launchedBy?: string
): Promise<LaunchResult> {
  const validationError = await validatePresetModelAvailability(preset, catalogCache);
  if (validationError) {
    throw new Error(validationError);
  }

  const args: string[] = [];

  // hcom <harness> [tool-args...]
  const command = HARNESS_COMMAND[preset.harness];
  args.push(command);

  // Model selection
  if (preset.model) {
    args.push("--model", preset.model);
  }

  // hcom flags
  args.push("--tag", preset.tag ?? preset.name);

  if (preset.headless !== false) {
    args.push("--headless");
  }

  if (preset.pty) {
    args.push("--pty");
  }

  if (overrides.dir ?? preset.dir) {
    args.push("--dir", overrides.dir ?? preset.dir!);
  }

  if (preset.systemPrompt) {
    if (preset.harness === "opencode") {
      const merged = `[System Role] ${preset.systemPrompt}\n\n${preset.prompt ?? ""}`.trim();
      args.push("--hcom-prompt", merged);
    } else {
      args.push("--hcom-system-prompt", preset.systemPrompt);
      if (preset.prompt) {
        args.push("--hcom-prompt", preset.prompt);
      }
    }
  } else if (preset.prompt) {
    args.push("--hcom-prompt", preset.prompt);
  }

  if (preset.reasoning) {
    if (preset.harness === "opencode" && preset.headless === false) {
      args.push("--variant", preset.reasoning);
    } else if (preset.harness === "claude") {
      args.push("--effort", preset.reasoning);
    }
    // headless opencode: reasoning variant injected via OPENCODE_CONFIG_CONTENT (see execOptions below)
    // codex: silently ignore
  }

  if (preset.headless !== false) {
    if (preset.harness === "codex") {
      args.push("--sandbox", "danger-full-access");
    } else if (preset.harness === "claude") {
      args.push("--dangerously-skip-permissions");
    }
    // opencode: trusted mode injected via OPENCODE_CONFIG_CONTENT (see execOptions below)
  }

  // --go to skip preview
  args.push("--go");

  // For trusted headless OpenCode sessions, inject a config that grants full permissions and
  // sets the requested reasoning variant. OPENCODE_CONFIG_CONTENT is a real OpenCode env var
  // that hcom does not overwrite or unset (unlike OPENCODE_PERMISSION), so it survives through
  // the hcom launch-script chain and reaches the opencode serve process.
  //
  // --dangerously-skip-permissions is intentionally NOT used here: it is only valid for
  // `opencode run`, not for `opencode serve` which is what hcom uses for headless launches.
  // The cwd-overlay approach is also not used: OpenCode discovers config relative to the project
  // tree, not the process cwd, so overlays written elsewhere are invisible to the runtime.
  const execOptions: ExecOptions = {};
  if (preset.headless !== false && preset.harness === "opencode") {
    const configContent: Record<string, any> = {
      permission: {
        // Headless managed sessions run in fully trusted mode. The hcom launch already injects
        // a narrow OPENCODE_PERMISSION; this config content widens it for unattended workers.
        "*": "allow",
        external_directory: "allow",
      },
    };
    if (preset.reasoning) {
      configContent.agent = {
        coder: { variant: preset.reasoning },
        orchestrator: { variant: preset.reasoning },
      };
    }
    execOptions.env = { OPENCODE_CONFIG_CONTENT: JSON.stringify(configContent) };
  }

  const result = await execHcom(args, execOptions);

  if (result.exitCode !== 0) {
    throw new Error(`hcom launch failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`);
  }

  // Parse output for agent names
  // Output format: "Names: aaaa bbbb ..." and "Batch id: xxxxx"
  const namesMatch = result.stdout.match(/Names:\s+(.+)/);
  const batchMatch = result.stdout.match(/Batch id:\s+(\S+)/);
  const hcomNames = namesMatch ? namesMatch[1].trim().split(/\s+/) : [];
  const batchId = batchMatch ? batchMatch[1] : null;

  // Record ownership for every launched worker name.
  const trackedNames = hcomNames.length > 0 ? hcomNames : [undefined];
  const records = trackedNames.map((hcomName) =>
    addRecord({
      workspace,
      harness: preset.harness,
      hcomName,
      preset: preset.name,
      launchMode: preset.headless !== false ? "headless" : "headed",
      state: "managed_active",
      released: false,
      launchedBy,
    })
  );

  return {
    presetName: preset.name,
    hcomNames,
    batchId,
    registryId: records[0].id,
    registryIds: records.map((record) => record.id),
    command: `hcom ${args.join(" ")}`,
  };
}
