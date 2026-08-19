import { z } from "zod";
import { execHcom, listHarnessModels, resolveCallerName } from "../hcom.js";
import type { ExecOptions, ModelDiscoveryResult } from "../hcom.js";
import { parseLaunchGateResult, parseLifeEvents, parseTermJson } from "../gate.js";
import { loadMergedConfig, resolveAgentPreset, resolveTopologyPreset, validateTopologyReferences } from "../config.js";
import { addRecord, removeRecords, updateRecordState, updateRecordVerify } from "../registry.js";
import { HARNESS_COMMAND, HarnessEnum } from "../types.js";
import type { AgentPreset, Harness, OwnershipState } from "../types.js";

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
  ttlMinutes?: number;
};

type LaunchResult = {
  presetName: string;
  hcomNames: string[];
  batchId: string | null;
  registryId: string;
  registryIds: string[];
  command: string;
  // Present only when hcom exited 2 (agent alive but blocked / still launching).
  blocked?: boolean;
  reason?: string;
};

export type { LaunchResult };

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
    ttlMinutes: preset.ttlMinutes,
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
      harness: HarnessEnum.describe("Harness variant to launch (claude, opencode, codex, antigravity)"),
      preset: z.string().optional().describe("Name of the agent preset from config (optional if model is provided)"),
      model: z.string().optional().describe("Model name override or standalone model for bare launches"),
      prompt: z.string().optional().describe("Initial prompt for the agent"),
      tag: z.string().optional().describe("Tag for the agent (defaults to harness name for bare launches)"),
      dir: z.string().optional().describe("Working directory override"),
      workspace: z.string().optional().describe("Workspace path for ownership tracking. Defaults to the server's working directory. Pass explicitly when the server runs under a service manager (its cwd is the service home, not your workspace) so records are scoped to the workspace you query with list_managed."),
      sender_name: z.string().optional().describe("Sender identity recorded as the launcher. Required for HTTP or unbound MCP callers when auto-resolution is unavailable."),
      reasoning: z.string().optional().describe("Reasoning effort level (opencode: --variant, claude: --effort, codex: ignored)"),
      ttl_minutes: z.number().int().positive().max(5256000).optional().describe("Ephemeral worker TTL in minutes: the record expires after this and prune expired=true kills + clears it. Overrides the preset's ttlMinutes. No background reaper — enforced lazily at the next list_managed/status/prune."),
    },
    async ({ harness, preset: presetName, model, prompt, tag, dir, workspace, sender_name, reasoning, ttl_minutes }: {
      harness: Harness;
      preset?: string;
      model?: string;
      prompt?: string;
      tag?: string;
      dir?: string;
      workspace?: string;
      sender_name?: string;
      reasoning?: string;
      ttl_minutes?: number;
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
          if (ttl_minutes) {
            resolvedPreset.ttlMinutes = ttl_minutes;
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
            ttlMinutes: ttl_minutes,
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
    "Launch multiple agents from a topology preset. Rolls back all if any fail. With verify=true, gates each launched agent on readiness (same gate as spawn_and_verify) and reports per-agent outcomes.",
    {
      topology: z.string().describe("Name of the topology preset from config"),
      workspace: z.string().optional().describe("Workspace path for ownership tracking. Defaults to the server's working directory. Pass explicitly when the server runs under a service manager (its cwd is the service home, not your workspace) so records are scoped to the workspace you query with list_managed."),
      sender_name: z.string().optional().describe("Sender identity recorded as the launcher. Required for HTTP or unbound MCP callers when auto-resolution is unavailable."),
      verify: z.boolean().optional().describe("Gate each launched agent on readiness and report outcomes (default: false)"),
      ready_timeout_sec: z.number().int().min(1).max(600).optional().describe("Seconds to wait for readiness when verify=true (default: 60)"),
      ttl_minutes: z.number().int().positive().max(5256000).optional().describe("Ephemeral worker TTL in minutes, applied to every role in the batch: records expire after this and prune expired=true kills + clears them. Overrides per-preset ttlMinutes. No background reaper — enforced lazily at the next list_managed/status/prune."),
    },
    async ({ topology: topologyName, workspace, sender_name, verify, ready_timeout_sec, ttl_minutes }: {
      topology: string;
      workspace?: string;
      sender_name?: string;
      verify?: boolean;
      ready_timeout_sec?: number;
      ttl_minutes?: number;
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
        const verifyOutcomes: VerifyOutcome[] = [];

        for (const { role, resolved } of resolvedRoles) {
          try {
            // Batch-level TTL applies to every role when set on the topology call.
            if (ttl_minutes) resolved.ttlMinutes = ttl_minutes;
            const result = await launchAgent(resolved, { prompt: resolved.prompt }, cwd, modelCatalogCache, callerName);
            launched.push(result);
            registryIds.push(...result.registryIds);

            if (verify) {
              const readyTimeoutSec = ready_timeout_sec ?? 60;
              for (const [index, name] of result.hcomNames.entries()) {
                const outcome = await verifyAgent(name, result.batchId, result.registryIds[index], {
                  workspace: cwd,
                  readyTimeoutSec,
                  onBlocked: "report",
                });
                verifyOutcomes.push(outcome);
              }
            }
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
              ...(verify ? { verifyOutcomes } : {}),
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
export async function launchAgent(
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

  // Parse output for agent names. hcom prints "Names: aaaa bbbb ..." and
  // "Batch id: xxxxx" on stdout for both success and non-zero exits.
  const namesMatch = result.stdout.match(/Names:\s+(.+)/);
  const batchMatch = result.stdout.match(/Batch id:\s+(\S+)/);
  const hcomNames = namesMatch ? namesMatch[1].trim().split(/\s+/) : [];
  const batchId = batchMatch ? batchMatch[1] : null;

  // No names parsed: nothing was spawned. Never record a nameless record —
  // that was the old "managed_active fiction" that could not be matched to a
  // live agent anyway.
  if (hcomNames.length === 0) {
    throw new Error(`hcom launch failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`);
  }

  // Record ownership BEFORE branching on the exit code: hcom's exit contract is
  // 0 = ready, 1 = spawn error / launch_failed, 2 = still launching or blocked
  // on user attention (agent alive). A live-but-blocked agent must never be
  // left invisible to kill/stop/list_managed/prune.
  const expiresAt = preset.ttlMinutes
    ? new Date(Date.now() + preset.ttlMinutes * 60 * 1000).toISOString()
    : undefined;
  const records = hcomNames.map((hcomName) =>
    addRecord({
      workspace,
      harness: preset.harness,
      hcomName,
      batchId: batchId ?? undefined,
      preset: preset.name,
      launchMode: preset.headless !== false ? "headless" : "headed",
      state: classifyLaunchState(result.exitCode),
      released: false,
      launchedBy,
      expiresAt,
    })
  );

  if (result.exitCode === 0) {
    return {
      presetName: preset.name,
      hcomNames,
      batchId,
      registryId: records[0].id,
      registryIds: records.map((record) => record.id),
      command: `hcom ${args.join(" ")}`,
    };
  }

  if (result.exitCode === 2) {
    // Agent is alive but still launching or blocked on user attention.
    // Not an error: the caller can watch it via hcom term <name>.
    return {
      presetName: preset.name,
      hcomNames,
      batchId,
      registryId: records[0].id,
      registryIds: records.map((record) => record.id),
      command: `hcom ${args.join(" ")}`,
      blocked: true,
      reason: `hcom launch exited ${result.exitCode}: agent(s) still launching or blocked on user attention. ` +
        `Recorded as managed_blocked. Inspect with hcom term ${hcomNames.join(" ")}, then retry or stop.`,
    };
  }

  // Exit 1 (or any other non-zero) with names parsed: the spawn failed but
  // something was created. Kill the corpse so it cannot linger, then throw.
  for (const name of hcomNames) {
    await execHcom(["kill", name, "--go"]);
  }
  throw new Error(
    `hcom launch failed (exit ${result.exitCode}): ${result.stderr || result.stdout}. ` +
      `Recorded as managed_lost and killed: ${hcomNames.join(", ")}.`
  );
}

/**
 * Map an hcom launch exit code to the ownership state recorded before the
 * outcome branch. 0 = ready, 2 = alive but blocked/still launching, anything
 * else with names parsed = spawn failure (corpse to be killed).
 */
function classifyLaunchState(exitCode: number): OwnershipState {
  if (exitCode === 0) return "managed_active";
  if (exitCode === 2) return "managed_blocked";
  return "managed_lost";
}

// --- Spawn verification (spawn_and_verify / launch_topology verify) ---

export interface VerifyOutcome {
  name: string;
  outcome: "ready" | "failed" | "timeout" | "blocked";
  latencyMs: number;
  reason?: string;
  detail?: string;
  screenTail?: string;
  rescued?: boolean;
  registryTransition?: string;
}

/**
 * Gate a launched agent on its batch reaching a terminal state. One
 * subprocess call (`hcom events launch <batchId> --timeout <sec>`), not a
 * polling loop. Falls back to a per-name `hcom events --wait` when the batch
 * id could not be scraped from the launch output.
 */
export async function gateLaunch(
  name: string,
  batchId: string | null,
  readyTimeoutSec: number,
  execHcomFn: typeof execHcom = execHcom,
): Promise<{ outcome: "ready" | "failed" | "timeout" | "blocked"; reason?: string; detail?: string }> {
  const gateTimeoutMs = (readyTimeoutSec + 10) * 1000;

  if (batchId) {
    const result = await execHcomFn(
      ["events", "launch", batchId, "--timeout", String(readyTimeoutSec)],
      { timeoutMs: gateTimeoutMs },
    );
    return parseLaunchGateResult(result.stdout, result.exitCode);
  }

  // Fallback: no batch id (older hcom). Wait for a terminal life event for
  // this agent; exit 2 is "timeout OR blocked" — disambiguate via the last
  // life event.
  const result = await execHcomFn(
    ["events", "--wait", String(readyTimeoutSec), "--type", "life", "--agent", name],
    { timeoutMs: gateTimeoutMs },
  );
  if (result.exitCode === 0) {
    const events = parseLifeEvents(result.stdout);
    const terminal = events.find(
      (e) => e.action === "ready" || e.action === "launch_failed" || e.action === "launch_blocked",
    );
    if (terminal?.action === "ready") return { outcome: "ready" };
    if (terminal?.action === "launch_failed") {
      return { outcome: "failed", reason: terminal.reason, detail: terminal.detail };
    }
    if (terminal?.action === "launch_blocked") {
      return { outcome: "blocked", reason: terminal.reason, detail: terminal.detail };
    }
  }
  return { outcome: "timeout" };
}

/**
 * Verify a single launched agent: gate on readiness, optionally rescue a
 * blocked agent (allowlist-guarded, iterating gates until ready), persist the
 * outcome on the registry record, and return a caller-readable report.
 */
export async function verifyAgent(
  name: string,
  batchId: string | null,
  registryId: string,
  options: {
    workspace: string;
    readyTimeoutSec: number;
    onBlocked: "report" | "rescue";
    execHcomFn?: typeof execHcom;
  },
): Promise<VerifyOutcome> {
  const execHcomFn = options.execHcomFn ?? execHcom;
  const startedAt = Date.now();

  let gate = await gateLaunch(name, batchId, options.readyTimeoutSec, execHcomFn);
  let rescued = false;

  if (gate.outcome === "blocked" && options.onBlocked === "rescue") {
    // Spawn-time rescue loop: iterate gates until ready (a trust dialog can
    // take two Enter cycles), still bounded and one-rescue-attempt-per-gate.
    // Dynamic import keeps the rescue path out of the launch module's link
    // surface so partial mocks of hcom/registry keep working for plain launch.
    const { runUnblock } = await import("./unblock.js");
    const maxGates = 3;
    for (let attempt = 1; attempt <= maxGates; attempt++) {
      const rescue = await runUnblock(name, {
        workspace: options.workspace,
        dryRun: false,
        waitSec: options.readyTimeoutSec,
        execHcomFn,
      });
      if (!rescue.ok) {
        gate = { outcome: "blocked", reason: "rescue refused", detail: rescue.text };
        break;
      }
      if (rescue.state === "ready") {
        rescued = true;
        gate = { outcome: "ready" };
        break;
      }
      if (rescue.state === "failed") {
        gate = { outcome: "failed", reason: "agent lost after rescue", detail: rescue.detail };
        break;
      }
      // Still blocked: one more gate cycle, then give up.
      gate = await gateLaunch(name, batchId, options.readyTimeoutSec, execHcomFn);
      if (gate.outcome === "ready") {
        rescued = true;
        break;
      }
      if (gate.outcome !== "blocked") break;
    }
  }

  const latencyMs = Date.now() - startedAt;

  // Persist the outcome onto the registry record: ready → active, failed →
  // lost (agent gone), timeout/blocked → blocked (alive but waiting).
  const persistedState: OwnershipState =
    gate.outcome === "ready" ? "managed_active"
    : gate.outcome === "failed" ? "managed_lost"
    : "managed_blocked";
  updateRecordState(registryId, persistedState);
  updateRecordVerify(registryId, {
    outcome: gate.outcome,
    latencyMs,
    reason: gate.reason,
  });

  const screenTail = gate.outcome === "blocked" || gate.outcome === "failed"
    ? await fetchScreenTailSafe(name, execHcomFn)
    : undefined;

  return {
    name,
    outcome: gate.outcome,
    latencyMs,
    reason: gate.reason,
    detail: gate.detail,
    screenTail,
    rescued,
    registryTransition: persistedState,
  };
}

/**
 * Read a screen tail without throwing; used for blocked/failed reports.
 */
async function fetchScreenTailSafe(
  name: string,
  execHcomFn: typeof execHcom,
): Promise<string> {
  const result = await execHcomFn(["term", name, "--json"]);
  if (result.exitCode !== 0) {
    return `(hcom term failed: ${result.stderr || result.stdout})`;
  }
  const screen = parseTermJson(result.stdout);
  return (screen.lines ?? []).slice(-30).join("\n");
}

/**
 * Register the spawn_and_verify tool: launch + readiness gate + optional
 * guarded rescue, with per-agent outcomes and a summary.
 */
export function registerSpawnAndVerifyTool(server: any) {
  server.tool(
    "spawn_and_verify",
    "Launch an agent and gate on readiness. Reuses the launch path unchanged; waits for the batch to reach a terminal state (one hcom events launch call, not a polling loop). Classifies ready / failed / timeout / blocked. With on_blocked=rescue, iterates allowlist-guarded rescue gates until ready. Persists outcome + latencyMs + reason on the registry record.",
    {
      harness: HarnessEnum.describe("Harness variant to launch (claude, opencode, codex, antigravity)"),
      preset: z.string().optional().describe("Name of the agent preset from config (optional if model is provided)"),
      model: z.string().optional().describe("Model name override or standalone model for bare launches"),
      prompt: z.string().optional().describe("Initial prompt for the agent"),
      tag: z.string().optional().describe("Tag for the agent (defaults to harness name for bare launches)"),
      dir: z.string().optional().describe("Working directory override"),
      workspace: z.string().optional().describe("Workspace path for ownership tracking. Defaults to the server's working directory. Pass explicitly when the server runs under a service manager (its cwd is the service home, not your workspace) so records are scoped to the workspace you query with list_managed."),
      sender_name: z.string().optional().describe("Sender identity recorded as the launcher. Required for HTTP or unbound MCP callers when auto-resolution is unavailable."),
      reasoning: z.string().optional().describe("Reasoning effort level (opencode: --variant, claude: --effort, codex: ignored)"),
      ready_timeout_sec: z.number().int().min(1).max(600).optional().describe("Seconds to wait for readiness (default: 60)"),
      on_blocked: z.enum(["report", "rescue"]).optional().describe("What to do when the agent is blocked on user attention (default: report)"),
      ttl_minutes: z.number().int().positive().max(5256000).optional().describe("Ephemeral worker TTL in minutes: the record expires after this and prune expired=true kills + clears it. Overrides the preset's ttlMinutes. No background reaper — enforced lazily at the next list_managed/status/prune."),
    },
    async ({ harness, preset: presetName, model, prompt, tag, dir, workspace, sender_name, reasoning, ready_timeout_sec, on_blocked, ttl_minutes }: {
      harness: Harness;
      preset?: string;
      model?: string;
      prompt?: string;
      tag?: string;
      dir?: string;
      workspace?: string;
      sender_name?: string;
      reasoning?: string;
      ready_timeout_sec?: number;
      on_blocked?: "report" | "rescue";
      ttl_minutes?: number;
    }) => {
      const cwd = workspace ?? process.cwd();
      const readyTimeoutSec = ready_timeout_sec ?? 60;
      const blockedMode = on_blocked ?? "report";

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

        if (!presetName && !model) {
          return {
            content: [{
              type: "text" as const,
              text: "Error: Provide at least a preset or a model. Use list_presets to see available presets, or specify harness + model for a bare launch.",
            }],
            isError: true,
          };
        }

        let resolvedPreset: ResolvedLaunchPreset;
        if (presetName) {
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
          resolvedPreset = resolvePresetHarness(preset, harness);
          if (model) resolvedPreset.model = model;
          if (tag) resolvedPreset.tag = tag;
          if (reasoning) resolvedPreset.reasoning = reasoning;
          if (ttl_minutes) resolvedPreset.ttlMinutes = ttl_minutes;
          resolvedPreset.prompt = prompt ?? resolvedPreset.prompt ?? defaultPromptForHarness(harness);
        } else {
          resolvedPreset = {
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
            ttlMinutes: ttl_minutes,
          };
        }

        const result = await launchAgent(resolvedPreset, { dir: dir ?? resolvedPreset.dir }, cwd, new Map(), callerName);

        const outcomes: VerifyOutcome[] = [];
        for (const [index, name] of result.hcomNames.entries()) {
          const outcome = await verifyAgent(name, result.batchId, result.registryIds[index], {
            workspace: cwd,
            readyTimeoutSec,
            onBlocked: blockedMode,
          });
          outcomes.push(outcome);
        }

        const summary = {
          total: outcomes.length,
          ready: outcomes.filter((o) => o.outcome === "ready").length,
          failed: outcomes.filter((o) => o.outcome === "failed").length,
          timeout: outcomes.filter((o) => o.outcome === "timeout").length,
          blocked: outcomes.filter((o) => o.outcome === "blocked").length,
          rescued: outcomes.filter((o) => o.rescued).length,
        };

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ launch: result, outcomes, summary }, null, 2),
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
