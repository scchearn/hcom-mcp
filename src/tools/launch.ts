import { z } from "zod";
import { execHcom, parseHcomJson } from "../hcom.js";
import { loadMergedConfig, resolveAgentPreset, resolveTopologyPreset, validateTopologyReferences } from "../config.js";
import { addRecord, removeRecords } from "../registry.js";
import { HARNESS_COMMAND } from "../types.js";
import type { AgentPreset, MergedConfig } from "../types.js";

/**
 * Register the hcom_launch tool for single-agent launch.
 */
export function registerLaunchTool(server: any) {
  server.tool(
    "hcom_launch",
    "Launch a headless hcom agent using a named agent preset from config",
    {
      preset: z.string().describe("Name of the agent preset from config"),
      prompt: z.string().optional().describe("Initial prompt for the agent"),
      dir: z.string().optional().describe("Working directory override"),
      workspace: z.string().optional().describe("Workspace path for ownership tracking"),
    },
    async ({ preset: presetName, prompt, dir, workspace }: {
      preset: string;
      prompt?: string;
      dir?: string;
      workspace?: string;
    }) => {
      const cwd = workspace ?? process.cwd();

      try {
        const config = loadMergedConfig(cwd);
        const preset = resolveAgentPreset(config, presetName);

        if (!preset) {
          return {
            content: [{
              type: "text" as const,
              text: `Error: Agent preset "${presetName}" not found. Available presets: ${Object.keys(config.agentPresets).join(", ")}`,
            }],
            isError: true,
          };
        }

        const result = await launchAgent(preset, { prompt, dir: dir ?? preset.dir }, cwd);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
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
 * Register the hcom_launch_topology tool for multi-agent batch launch.
 */
export function registerTopologyLaunchTool(server: any) {
  server.tool(
    "hcom_launch_topology",
    "Launch multiple agents from a topology preset. Rolls back all if any fail.",
    {
      topology: z.string().describe("Name of the topology preset from config"),
      workspace: z.string().optional().describe("Workspace path for ownership tracking"),
    },
    async ({ topology: topologyName, workspace }: {
      topology: string;
      workspace?: string;
    }) => {
      const cwd = workspace ?? process.cwd();

      try {
        const config = loadMergedConfig(cwd);
        const topology = resolveTopologyPreset(config, topologyName);

        if (!topology) {
          return {
            content: [{
              type: "text" as const,
              text: `Error: Topology preset "${topologyName}" not found. Available: ${Object.keys(config.topologyPresets).join(", ")}`,
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

        // Launch agents one at a time, collecting results for rollback on failure
        const launched: Array<{
          presetName: string;
          hcomNames: string[];
          batchId: string | null;
          registryId: string;
          command: string;
        }> = [];
        const registryIds: string[] = [];

        for (const role of topology.roles) {
          const preset = resolveAgentPreset(config, role.preset);
          if (!preset) {
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
                text: `Error: Preset "${role.preset}" for role "${role.role}" not found during launch. Rolled back ${launched.length} agents.`,
              }],
              isError: true,
            };
          }

          // Apply role-specific tag override
          const rolePreset: AgentPreset = {
            ...preset,
            tag: preset.tag ?? role.role,
            prompt: preset.prompt,
          };

          try {
            const result = await launchAgent(rolePreset, { prompt: preset.prompt }, cwd);
            launched.push(result);
            registryIds.push(result.registryId);
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
  preset: AgentPreset,
  overrides: { prompt?: string; dir?: string },
  workspace: string
): Promise<{
  presetName: string;
  hcomNames: string[];
  batchId: string | null;
  registryId: string;
  command: string;
}> {
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

  if (overrides.prompt ?? preset.prompt) {
    args.push("--hcom-prompt", overrides.prompt ?? preset.prompt!);
  }

  if (preset.systemPrompt) {
    args.push("--hcom-system-prompt", preset.systemPrompt);
  }

  // --go to skip preview
  args.push("--go");

  const result = await execHcom(args);

  if (result.exitCode !== 0) {
    throw new Error(`hcom launch failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`);
  }

  // Parse output for agent names
  // Output format: "Names: aaaa bbbb ..." and "Batch id: xxxxx"
  const namesMatch = result.stdout.match(/Names:\s+(.+)/);
  const batchMatch = result.stdout.match(/Batch id:\s+(\S+)/);
  const hcomNames = namesMatch ? namesMatch[1].trim().split(/\s+/) : [];
  const batchId = batchMatch ? batchMatch[1] : null;

  // Record ownership
  const record = addRecord({
    workspace,
    harness: preset.harness,
    hcomName: hcomNames[0],
    preset: preset.name,
    launchMode: preset.headless !== false ? "headless" : "headed",
    state: "managed_active",
    released: false,
  });

  return {
    presetName: preset.name,
    hcomNames,
    batchId,
    registryId: record.id,
    command: `hcom ${args.join(" ")}`,
  };
}