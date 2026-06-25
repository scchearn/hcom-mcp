import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { HarnessEnum } from "./types.js";
import type { Harness, HcomAgent } from "./types.js";

const execFileAsync = promisify(execFile);

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ExecOptions {
  cwd?: string;
  // Extra env vars merged on top of process.env before exec. Useful for injecting
  // env vars that hcom does not overwrite (e.g. OPENCODE_CONFIG_CONTENT).
  env?: Record<string, string>;
}

/**
 * Execute an arbitrary CLI command.
 */
export async function execCommand(
  command: string,
  args: string[],
  options: ExecOptions = {},
): Promise<ExecResult> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30_000,
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.env ? { env: { ...process.env, ...options.env } } : {}),
    });
    return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode: 0 };
  } catch (err: any) {
    return {
      stdout: (err.stdout || "").toString().trim(),
      stderr: (err.stderr || "").toString().trim(),
      exitCode: err.code ?? 1,
    };
  }
}

/**
 * Execute an hcom CLI command.
 * @param args - Arguments to pass to hcom (e.g., ["list", "--json"])
 * @returns Parsed result with stdout, stderr, and exit code
 */
export async function execHcom(args: string[], options: ExecOptions = {}): Promise<ExecResult> {
  return execCommand("hcom", args, options);
}

/**
 * Check if hcom CLI is available on PATH.
 */
export async function isHcomAvailable(): Promise<boolean> {
  const result = await execHcom(["--version"]);
  return result.exitCode === 0;
}

/**
 * Parse JSON output from hcom commands that support --json.
 * Returns null if parsing fails.
 */
export function parseHcomJson<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * Resolve the hcom CVCV name of the calling agent/session.
 * Uses `hcom list self --json` if no override is provided.
 * Returns undefined if the caller cannot be resolved (unbound session).
 */
export async function resolveCallerName(override?: string): Promise<string | undefined> {
  if (override) return override;

  const result = await execHcom(["list", "self", "--json"]);
  if (result.exitCode === 0) {
    const parsed = parseHcomJson<{ name?: string }>(result.stdout);
    return parsed?.name ?? undefined;
  }

  return undefined;
}

/**
 * Load all live hcom agents as reported by `hcom list --json`.
 */
export async function listHcomAgents(): Promise<HcomAgent[]> {
  const result = await execHcom(["list", "--json"]);
  if (result.exitCode !== 0) {
    throw new Error(`hcom list failed: ${result.stderr || result.stdout}`);
  }

  return parseHcomJson<HcomAgent[]>(result.stdout) ?? [];
}

/**
 * Match an hcom agent by either its display `name` or bare `base_name`.
 */
export function findLiveAgentByIdentifier(
  identifier: string,
  agents: HcomAgent[],
): HcomAgent | null {
  return (
    agents.find(
      (agent) => agent.name === identifier || agent.base_name === identifier,
    ) ?? null
  );
}

// --- Model discovery helpers ---

/**
 * Infer the harness enum from an HcomAgent.tool value.
 * Returns null for unknown/undefined tool values.
 */
export function inferHarnessFromTool(tool: string | undefined): Harness | null {
  if (!tool) return null;
  // HcomAgent.tool matches HarnessEnum values directly: "opencode", "claude", "codex"
  if (HarnessEnum.options.includes(tool as Harness)) {
    return tool as Harness;
  }
  return null;
}

export interface ModelDiscoveryResult {
  harness: Harness;
  status: "live" | "bundled" | "error";
  models: string[];
  count: number;
  source: string;
  reason?: string;
  notes?: string[];
}

const BUNDLED_CLAUDE_MODELS = ["sonnet", "opus", "haiku"];

const BUNDLED_CLAUDE_NOTES = [
  "Aliases resolve to provider/account defaults.",
  "Append [1m] for extended context where supported.",
  "Additional Haiku variants may be available per provider.",
];

const BUNDLED_CODEX_MODELS = [
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.3-codex",
  "gpt-5.3-codex-spark",
  "gpt-5.2",
];

function bundledCatalog(
  harness: Harness,
  models: string[],
  notes?: string[],
): ModelDiscoveryResult {
  return {
    harness,
    status: "bundled",
    models,
    count: models.length,
    source: "bundled catalog",
    notes,
  };
}

/**
 * Discover models for a single harness by shelling out to its CLI.
 */
export async function discoverHarnessModels(
  harness: Harness,
): Promise<ModelDiscoveryResult> {
  if (harness === "opencode") {
    const result = await execCommand("opencode", ["models"]);
    if (result.exitCode !== 0) {
      return {
        harness,
        status: "error",
        models: [],
        count: 0,
        source: "opencode models CLI",
        reason: `opencode models exited ${result.exitCode}: ${result.stderr || result.stdout}`,
      };
    }
    const models = result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => /^[^\s/]+\/[^\s]+$/.test(line));
    return {
      harness,
      status: "live",
      models,
      count: models.length,
      source: "opencode models CLI",
    };
  }

  if (harness === "claude") {
    return bundledCatalog(harness, BUNDLED_CLAUDE_MODELS, BUNDLED_CLAUDE_NOTES);
  }

  return bundledCatalog(harness, BUNDLED_CODEX_MODELS);
}

/**
 * Discover models for one or all harnesses.
 */
export async function listHarnessModels(
  harness?: Harness,
): Promise<ModelDiscoveryResult[]> {
  if (harness) {
    return [await discoverHarnessModels(harness)];
  }

  const allHarnesses = HarnessEnum.options;
  return Promise.all(allHarnesses.map((h) => discoverHarnessModels(h)));
}
