import { z } from "zod";

// --- Harness types ---

// All 11 harnesses hcom supports. Every entry must have a working
// HARNESS_COMMAND and HARNESS_ENV_ARGS mapping below.
export const HarnessEnum = z.enum([
  "claude",
  "opencode",
  "codex",
  "antigravity",
  "gemini",
  "kilo",
  "pi",
  "omp",
  "cursor",
  "kimi",
  "copilot",
]);
export type Harness = z.infer<typeof HarnessEnum>;

// Maps harness name to hcom CLI subcommand
export const HARNESS_COMMAND: Record<Harness, string> = {
  claude: "claude",
  opencode: "opencode",
  codex: "codex",
  antigravity: "agy",
  gemini: "gemini",
  kilo: "kilo",
  pi: "pi",
  omp: "omp",
  cursor: "cursor-agent",
  kimi: "kimi",
  copilot: "copilot",
};

// Maps harness name to the environment variable for default model args
export const HARNESS_ENV_ARGS: Record<Harness, string> = {
  claude: "HCOM_CLAUDE_ARGS",
  opencode: "HCOM_OPENCODE_ARGS",
  codex: "HCOM_CODEX_ARGS",
  // ponytail: antigravity has no HCOM_*_ARGS env today; placeholder keeps the Record total
  antigravity: "HCOM_ANTIGRAVITY_ARGS",
  gemini: "HCOM_GEMINI_ARGS",
  kilo: "HCOM_KILO_ARGS",
  pi: "HCOM_PI_ARGS",
  omp: "HCOM_OMP_ARGS",
  cursor: "HCOM_CURSOR_ARGS",
  kimi: "HCOM_KIMI_ARGS",
  copilot: "HCOM_COPILOT_ARGS",
};

// --- Launch modes ---

export const LaunchModeEnum = z.enum(["headless", "headed"]);
export type LaunchMode = z.infer<typeof LaunchModeEnum>;

// --- Ownership states ---

export const OwnershipStateEnum = z.enum([
  "managed_active",
  "managed_stopped",
  "managed_blocked",
  "managed_released",
  "managed_lost",
  "managed_expired",
  "adopted_active",
  "adopted_stopped",
  "adopted_lost",
  "adopted_expired",
]);
export type OwnershipState = z.infer<typeof OwnershipStateEnum>;

// --- Agent preset schema ---

export const HarnessVariantSchema = z.object({
  model: z.string().min(1),
  reasoning: z.string().optional(),
});
export type HarnessVariant = z.infer<typeof HarnessVariantSchema>;

export const AgentPresetHarnessMapSchema = z
  .object({
    claude: HarnessVariantSchema.optional(),
    opencode: HarnessVariantSchema.optional(),
    codex: HarnessVariantSchema.optional(),
    antigravity: HarnessVariantSchema.optional(),
    gemini: HarnessVariantSchema.optional(),
    kilo: HarnessVariantSchema.optional(),
    pi: HarnessVariantSchema.optional(),
    omp: HarnessVariantSchema.optional(),
    cursor: HarnessVariantSchema.optional(),
    kimi: HarnessVariantSchema.optional(),
    copilot: HarnessVariantSchema.optional(),
  })
  .refine((value) => Object.values(value).some(Boolean), {
    message: "At least one harness variant is required",
  });
export type AgentPresetHarnessMap = z.infer<typeof AgentPresetHarnessMapSchema>;

export const AgentPresetSharedSchema = z.object({
  name: z.string().min(1),
  headless: z.boolean().default(true),
  pty: z.boolean().default(false),
  tag: z.string().optional(),
  dir: z.string().optional(),
  prompt: z.string().optional(),
  systemPrompt: z.string().optional(),
  // Ephemeral workers: minutes until the launched agent's record expires.
  // Persisted as expiresAt on the registry record; prune expired=true kills
  // and clears them. No background reaper — lazy enforcement at next look.
  ttlMinutes: z.number().int().positive().max(5256000).optional(),
});

export const AgentPresetSchema = AgentPresetSharedSchema.extend({
  harness: AgentPresetHarnessMapSchema,
});
export type AgentPreset = z.infer<typeof AgentPresetSchema>;

export const LegacyAgentPresetSchema = AgentPresetSharedSchema.extend({
  harness: HarnessEnum,
  model: z.string().min(1),
});
export type LegacyAgentPreset = z.infer<typeof LegacyAgentPresetSchema>;

export const AgentPresetInputSchema = z.union([AgentPresetSchema, LegacyAgentPresetSchema]);
export type AgentPresetInput = z.infer<typeof AgentPresetInputSchema>;

// --- Topology role schema ---

export const TopologyRoleSchema = z.object({
  role: z.string().min(1),
  preset: z.string().min(1), // references an AgentPreset name
  harness: HarnessEnum,
  count: z.number().int().min(1).default(1),
});
export type TopologyRole = z.infer<typeof TopologyRoleSchema>;

// --- Hub reference schema ---

export const HubReferenceSchema = z.object({
  type: z.enum(["name", "tag", "thread"]),
  value: z.string().min(1),
});
export type HubReference = z.infer<typeof HubReferenceSchema>;

// --- Topology preset schema ---

export const TopologyPresetSchema = z.object({
  name: z.string().min(1),
  roles: z.array(TopologyRoleSchema).min(1),
  hub: HubReferenceSchema.optional(),
  threadPrefix: z.string().optional(),
});
export type TopologyPreset = z.infer<typeof TopologyPresetSchema>;

// --- Rescue allowlist (unblock / spawn_and_verify) ---

// Regexes matched (case-insensitive) against the launch_blocked detail text to
// decide whether a blocked agent is stuck on a rescuable dialog (workspace
// trust, permission-mode default, model/provider picker). Config-driven so new
// dialogs never require a code release. One rescue attempt max per gate; a
// dialog surviving one Enter needs a human.
export const RescueAllowlistSchema = z.object({
  enabled: z.boolean().default(true),
  patterns: z.array(z.string().min(1)).default([
    "trust this folder",
    "do you trust",
    "permission mode",
    "select a model",
    "choose a provider",
  ]),
});
export type RescueAllowlist = z.infer<typeof RescueAllowlistSchema>;

// --- Global config schema ---

export const GlobalConfigInputSchema = z.object({
  agentPresets: z.record(z.string(), AgentPresetInputSchema).default({}),
  topologyPresets: z.record(z.string(), TopologyPresetSchema).default({}),
  rescueAllowlist: RescueAllowlistSchema.default({}),
});
export type GlobalConfigInput = z.infer<typeof GlobalConfigInputSchema>;

export const GlobalConfigSchema = z.object({
  agentPresets: z.record(z.string(), AgentPresetSchema).default({}),
  topologyPresets: z.record(z.string(), TopologyPresetSchema).default({}),
  rescueAllowlist: RescueAllowlistSchema.default({}),
});
export type GlobalConfig = z.infer<typeof GlobalConfigSchema>;

// --- Workspace config schema (overlay) ---

export const WorkspaceConfigInputSchema = z.object({
  agentPresets: z.record(z.string(), AgentPresetInputSchema).optional(),
  topologyPresets: z.record(z.string(), TopologyPresetSchema).optional(),
  rescueAllowlist: RescueAllowlistSchema.optional(),
});
export type WorkspaceConfigInput = z.infer<typeof WorkspaceConfigInputSchema>;

export const WorkspaceConfigSchema = z.object({
  agentPresets: z.record(z.string(), AgentPresetSchema).optional(),
  topologyPresets: z.record(z.string(), TopologyPresetSchema).optional(),
  rescueAllowlist: RescueAllowlistSchema.optional(),
});
export type WorkspaceConfig = z.infer<typeof WorkspaceConfigSchema>;

// --- Merged config (what the server actually uses) ---

export const MergedConfigSchema = z.object({
  agentPresets: z.record(z.string(), AgentPresetSchema),
  topologyPresets: z.record(z.string(), TopologyPresetSchema),
  rescueAllowlist: RescueAllowlistSchema.default({}),
});
export type MergedConfig = z.infer<typeof MergedConfigSchema>;

// --- Registry record schema ---

export const RegistryRecordSchema = z.object({
  id: z.string(),
  workspace: z.string(),
  harness: HarnessEnum,
  hcomName: z.string().optional(),
  sessionId: z.string().optional(),
  batchId: z.string().optional(),
  preset: z.string().optional(),
  topology: z.string().optional(),
  topologyRole: z.string().optional(),
  launchMode: LaunchModeEnum.optional(),
  state: OwnershipStateEnum,
  launchedBy: z.string().optional(),
  createdAt: z.string(),
  lastSeenAt: z.string(),
  released: z.boolean().default(false),
  // Spawn verification outcome (spawn_and_verify / launch_topology verify).
  verifyOutcome: z.enum(["ready", "failed", "timeout", "blocked"]).optional(),
  verifyLatencyMs: z.number().optional(),
  verifyReason: z.string().optional(),
  // Ephemeral worker TTL: ISO timestamp after which the record is expired.
  // Set at launch from ttlMinutes (preset or tool param); reconcile flags
  // expired records and prune expired=true kills + clears them.
  expiresAt: z.string().optional(),
  // Handoff provenance: set on records created by resume/fork, linking the
  // new record to the source agent's record id (resume) or name (fork).
  resumedFrom: z.string().optional(),
});
export type RegistryRecord = z.infer<typeof RegistryRecordSchema>;

// --- Hcom list output item ---

export const HcomAgentSchema = z.object({
  name: z.string(),
  base_name: z.string(),
  status: z.string(),
  status_age_seconds: z.number().optional(),
  status_context: z.string().optional(),
  status_detail: z.string().optional(),
  description: z.string().optional(),
  unread_count: z.number().optional(),
  tool: z.string().optional(),
  tag: z.string().nullable().optional(),
  directory: z.string().optional(),
  session_id: z.string().optional(),
  headless: z.boolean().optional(),
});
export type HcomAgent = z.infer<typeof HcomAgentSchema>;
