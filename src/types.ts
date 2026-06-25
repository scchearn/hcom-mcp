import { z } from "zod";

// --- Harness types ---

export const HarnessEnum = z.enum(["claude", "opencode", "codex"]);
export type Harness = z.infer<typeof HarnessEnum>;

// Maps harness name to hcom CLI subcommand
export const HARNESS_COMMAND: Record<Harness, string> = {
  claude: "claude",
  opencode: "opencode",
  codex: "codex",
};

// Maps harness name to the environment variable for default model args
export const HARNESS_ENV_ARGS: Record<Harness, string> = {
  claude: "HCOM_CLAUDE_ARGS",
  opencode: "HCOM_OPENCODE_ARGS",
  codex: "HCOM_CODEX_ARGS",
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
  "adopted_active",
  "adopted_stopped",
  "adopted_lost",
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

// --- Global config schema ---

export const GlobalConfigInputSchema = z.object({
  agentPresets: z.record(z.string(), AgentPresetInputSchema).default({}),
  topologyPresets: z.record(z.string(), TopologyPresetSchema).default({}),
});
export type GlobalConfigInput = z.infer<typeof GlobalConfigInputSchema>;

export const GlobalConfigSchema = z.object({
  agentPresets: z.record(z.string(), AgentPresetSchema).default({}),
  topologyPresets: z.record(z.string(), TopologyPresetSchema).default({}),
});
export type GlobalConfig = z.infer<typeof GlobalConfigSchema>;

// --- Workspace config schema (overlay) ---

export const WorkspaceConfigInputSchema = z.object({
  agentPresets: z.record(z.string(), AgentPresetInputSchema).optional(),
  topologyPresets: z.record(z.string(), TopologyPresetSchema).optional(),
});
export type WorkspaceConfigInput = z.infer<typeof WorkspaceConfigInputSchema>;

export const WorkspaceConfigSchema = z.object({
  agentPresets: z.record(z.string(), AgentPresetSchema).optional(),
  topologyPresets: z.record(z.string(), TopologyPresetSchema).optional(),
});
export type WorkspaceConfig = z.infer<typeof WorkspaceConfigSchema>;

// --- Merged config (what the server actually uses) ---

export const MergedConfigSchema = z.object({
  agentPresets: z.record(z.string(), AgentPresetSchema),
  topologyPresets: z.record(z.string(), TopologyPresetSchema),
});
export type MergedConfig = z.infer<typeof MergedConfigSchema>;

// --- Registry record schema ---

export const RegistryRecordSchema = z.object({
  id: z.string(),
  workspace: z.string(),
  harness: HarnessEnum,
  hcomName: z.string().optional(),
  sessionId: z.string().optional(),
  preset: z.string().optional(),
  topology: z.string().optional(),
  topologyRole: z.string().optional(),
  launchMode: LaunchModeEnum.optional(),
  state: OwnershipStateEnum,
  launchedBy: z.string().optional(),
  createdAt: z.string(),
  lastSeenAt: z.string(),
  released: z.boolean().default(false),
});
export type RegistryRecord = z.infer<typeof RegistryRecordSchema>;

// --- Hcom list output item ---

export const HcomAgentSchema = z.object({
  name: z.string(),
  base_name: z.string(),
  status: z.string(),
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
