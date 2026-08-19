import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { findLiveAgentByIdentifier, listHcomAgents, listStoppedAgentNames } from "./hcom.js";import {
  RegistryRecordSchema,
  type RegistryRecord,
  type OwnershipState,
  type Harness,
  type HcomAgent,
} from "./types.js";

export const REGISTRY_DIR = join(homedir(), ".hcom", "mcp");
export const REGISTRY_PATH = join(REGISTRY_DIR, "registry.json");

interface Registry {
  records: RegistryRecord[];
}

/**
 * Typed error for registry load failures. Carries the quarantine path when the
 * corrupt data was preserved for inspection instead of being lost.
 */
export class RegistryError extends Error {
  readonly quarantinePath?: string;

  constructor(message: string, quarantinePath?: string) {
    super(message);
    this.name = "RegistryError";
    this.quarantinePath = quarantinePath;
  }
}

/**
 * Preserve corrupt registry data at registry.corrupt-<ts>.json so a parse
 * failure never silently destroys the only copy of the records.
 */
function quarantine(content: string, reason: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const quarantinePath = join(REGISTRY_DIR, `registry.corrupt-${ts}.json`);
  try {
    writeFileSync(quarantinePath, content, "utf-8");
  } catch (err: any) {
    throw new RegistryError(
      `Registry at ${REGISTRY_PATH} is corrupt (${reason}) and could not be quarantined to ${quarantinePath}: ${err.message}`,
    );
  }
  return quarantinePath;
}

function loadRegistry(): Registry {
  if (!existsSync(REGISTRY_PATH)) {
    return { records: [] };
  }

  let raw: string;
  try {
    raw = readFileSync(REGISTRY_PATH, "utf-8");
  } catch (err: any) {
    throw new RegistryError(`Failed to read registry at ${REGISTRY_PATH}: ${err.message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err: any) {
    const quarantinePath = quarantine(raw, err.message);
    throw new RegistryError(
      `Registry at ${REGISTRY_PATH} is not valid JSON (${err.message}). ` +
        `The file was quarantined to ${quarantinePath} and no records were loaded.`,
      quarantinePath,
    );
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !Array.isArray((parsed as { records?: unknown }).records)
  ) {
    const quarantinePath = quarantine(raw, "expected { records: [...] }");
    throw new RegistryError(
      `Registry at ${REGISTRY_PATH} has an unexpected shape (expected { records: [...] }). ` +
        `The file was quarantined to ${quarantinePath} and no records were loaded.`,
      quarantinePath,
    );
  }

  // Per-record recovery: keep valid records and quarantine invalid ones instead
  // of losing the whole registry over one bad record.
  const records: RegistryRecord[] = [];
  const bad: unknown[] = [];
  for (const r of (parsed as { records: unknown[] }).records) {
    const parsedRecord = RegistryRecordSchema.safeParse(r);
    if (parsedRecord.success) {
      records.push(parsedRecord.data);
    } else {
      bad.push(r);
    }
  }

  if (bad.length > 0) {
    const quarantinePath = quarantine(JSON.stringify(bad, null, 2), `${bad.length} invalid record(s)`);
    // Heal the live file so the bad records are not re-quarantined on every load.
    saveRegistry({ records });
    throw new RegistryError(
      `Registry at ${REGISTRY_PATH} contained ${bad.length} invalid record(s). ` +
        `Valid records were kept; invalid ones were quarantined to ${quarantinePath}.`,
      quarantinePath,
    );
  }

  return { records };
}

function saveRegistry(registry: Registry): void {
  if (!existsSync(REGISTRY_DIR)) {
    mkdirSync(REGISTRY_DIR, { recursive: true });
  }
  // Atomic write: a crash mid-write can truncate the live file, so write to a
  // temp path and rename over the target. Lost-update races between concurrent
  // writers are accepted (reconcile rebuilds from `hcom list`); no locking.
  const tmpPath = `${REGISTRY_PATH}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(registry, null, 2), "utf-8");
  renameSync(tmpPath, REGISTRY_PATH);
}

/**
 * Add a new ownership record.
 */
export function addRecord(record: Omit<RegistryRecord, "id" | "createdAt" | "lastSeenAt">): RegistryRecord {
  const registry = loadRegistry();
  const now = new Date().toISOString();
  const full: RegistryRecord = {
    ...record,
    id: randomUUID(),
    createdAt: now,
    lastSeenAt: now,
  };
  registry.records.push(full);
  saveRegistry(registry);
  return full;
}

/**
 * Get all records for a workspace.
 */
export function getRecordsByWorkspace(workspace: string): RegistryRecord[] {
  const registry = loadRegistry();
  return registry.records.filter((r) => r.workspace === workspace);
}

/**
 * Get all non-released records for a workspace, including lost/stopped records.
 */
export function getOwnedRecordsByWorkspace(workspace: string): RegistryRecord[] {
  return getRecordsByWorkspace(workspace).filter((r) => !r.released);
}

/**
 * Update a record's state.
 */
export function updateRecordState(id: string, state: OwnershipState): RegistryRecord | null {
  const registry = loadRegistry();
  const record = registry.records.find((r) => r.id === id);
  if (!record) return null;
  record.state = state;
  record.lastSeenAt = new Date().toISOString();
  saveRegistry(registry);
  return record;
}

/**
 * Persist a spawn-verification outcome (spawn_and_verify / launch_topology
 * verify) onto a record: outcome, latency, and reason.
 */
export function updateRecordVerify(
  id: string,
  info: { outcome: "ready" | "failed" | "timeout" | "blocked"; latencyMs: number; reason?: string },
): RegistryRecord | null {
  const registry = loadRegistry();
  const record = registry.records.find((r) => r.id === id);
  if (!record) return null;
  record.verifyOutcome = info.outcome;
  record.verifyLatencyMs = info.latencyMs;
  record.verifyReason = info.reason;
  record.lastSeenAt = new Date().toISOString();
  saveRegistry(registry);
  return record;
}

/**
 * Update a record's hcom name and session ID (after hcom assigns them).
 */
export function updateRecordHcomInfo(
  id: string,
  hcomName: string,
  sessionId?: string
): RegistryRecord | null {
  const registry = loadRegistry();
  const record = registry.records.find((r) => r.id === id);
  if (!record) return null;
  record.hcomName = hcomName;
  if (sessionId) record.sessionId = sessionId;
  record.lastSeenAt = new Date().toISOString();
  saveRegistry(registry);
  return record;
}

/**
 * Mark a record as released (handed off to human).
 */
export function releaseRecord(id: string): RegistryRecord | null {
  const registry = loadRegistry();
  const record = registry.records.find((r) => r.id === id);
  if (!record) return null;
  record.released = true;
  record.state = "managed_released";
  record.lastSeenAt = new Date().toISOString();
  saveRegistry(registry);
  return record;
}

/**
 * Remove records by ID (used for rollback).
 */
export function removeRecords(ids: string[]): void {
  const registry = loadRegistry();
  registry.records = registry.records.filter((r) => !ids.includes(r.id));
  saveRegistry(registry);
}

/**
 * Get all managed records for a workspace that are still owned (not released, not lost).
 */
export function getActiveRecords(workspace: string): RegistryRecord[] {
  return getRecordsByWorkspace(workspace).filter(
    (r) => !r.released && r.state !== "managed_lost" && r.state !== "adopted_lost"
  );
}

/**
 * Create an adopted record for an existing hcom agent.
 * Adopted records have preset "adopted", state "adopted_active", and no launch metadata.
 */
export function adoptRecord(params: {
  workspace: string;
  harness: Harness;
  hcomName: string;
  sessionId?: string;
}): RegistryRecord {
  const registry = loadRegistry();
  const now = new Date().toISOString();
  const full: RegistryRecord = {
    id: randomUUID(),
    workspace: params.workspace,
    harness: params.harness,
    hcomName: params.hcomName,
    sessionId: params.sessionId,
    preset: "adopted",
    state: "adopted_active",
    // Adopted records have no launch metadata
    launchedBy: undefined,
    topology: undefined,
    topologyRole: undefined,
    createdAt: now,
    lastSeenAt: now,
    released: false,
  };
  registry.records.push(full);
  saveRegistry(registry);
  return full;
}

/**
 * Find the first non-released record matching workspace + hcomName.
 * Used for idempotency checks in adopt.
 */
export function findRecordByWorkspaceAndName(
  workspace: string,
  hcomName: string,
): RegistryRecord | undefined {
  const registry = loadRegistry();
  return registry.records.find(
    (r) => r.workspace === workspace && r.hcomName === hcomName && !r.released,
  );
}

/**
 * Match a record to a live hcom agent by its stored base name.
 */
export function matchLiveAgent(
  record: Pick<RegistryRecord, "hcomName">,
  hcomAgents: HcomAgent[]
): HcomAgent | null {
  if (!record.hcomName) {
    return null;
  }

  return findLiveAgentByIdentifier(record.hcomName, hcomAgents);
}

/**
 * Settle registry records against live hcom state. This is the single
 * live-vs-record truth engine: it demotes never-live records to lost, promotes
 * stopped/blocked records that are live again, and keeps cleanly-stopped
 * records stopped. `stoppedNames` (from `hcom list --stopped`) lets a record
 * that stopped cleanly stay stopped instead of being demoted to lost.
 */
export function reconcileManagedRecords(
  records: RegistryRecord[],
  hcomAgents: HcomAgent[],
  stoppedNames: string[] = [],
): RegistryRecord[] {
  return records.map((record) => {
    if (record.released || !record.hcomName) {
      return record;
    }

    const liveAgent = matchLiveAgent(record, hcomAgents);

    // Reverse reconcile stopped→active for both managed and adopted
    if (
      (record.state === "managed_stopped" || record.state === "adopted_stopped") &&
      liveAgent
    ) {
      const newState = record.state === "managed_stopped" ? "managed_active" : "adopted_active";
      return { ...record, state: newState as OwnershipState };
    }

    // Blocked records: the agent was alive but waiting on user attention or
    // still launching. If it is live again, promote to active; if it is gone,
    // demote to lost.
    if (record.state === "managed_blocked") {
      return { ...record, state: (liveAgent ? "managed_active" : "managed_lost") as OwnershipState };
    }

    // Stopped records: keep them stopped when the agent stopped cleanly
    // (present in `hcom list --stopped`); demote to lost when it vanished
    // without a clean stop.
    if (record.state === "managed_stopped" || record.state === "adopted_stopped") {
      if (stoppedNames.includes(record.hcomName)) return record;
      const lostState = record.state === "managed_stopped" ? "managed_lost" : "adopted_lost";
      return { ...record, state: lostState as OwnershipState };
    }

    // For managed_lost, skip further transitions (preserve existing behavior)
    if (record.state === "managed_lost") {
      return record;
    }

    // For adopted_lost, skip further transitions
    if (record.state === "adopted_lost") {
      return record;
    }

    // Managed active but not found live → managed_lost
    if (record.state === "managed_active" && !liveAgent) {
      return { ...record, state: "managed_lost" as const };
    }

    // Adopted active but not found live → adopted_lost
    if (record.state === "adopted_active" && !liveAgent) {
      return { ...record, state: "adopted_lost" as const };
    }

    return record;
  });
}

/**
 * Reconcile a workspace's records against live hcom state and persist any
 * state transitions. Returns the reconciled records.
 */
export async function reconcileWorkspaceRecords(workspace: string): Promise<RegistryRecord[]> {
  const records = getOwnedRecordsByWorkspace(workspace);
  const [hcomAgents, stoppedNames] = await Promise.all([
    listHcomAgents(),
    listStoppedAgentNames(),
  ]);
  const reconciled = reconcileManagedRecords(records, hcomAgents, stoppedNames);
  persistReconciledState(records, reconciled);
  return reconciled;
}

export function persistReconciledState(before: RegistryRecord[], after: RegistryRecord[]) {
  for (const [index, record] of after.entries()) {
    if (record.state !== before[index]?.state) {
      updateRecordState(record.id, record.state);
    }
  }
}

/**
 * Prune stale registry records based on state and age.
 * Reconciles against live hcom state FIRST so never-live records are demoted
 * to lost where the age rules can reach them (kills the phantom-active
 * bucket), then applies the age rules.
 * Returns the list of records that would be (or were) removed.
 */
export async function pruneRecords(
  workspace: string,
  options: {
    olderThanDays?: number;
    lostOlderThanDays?: number;
    includeStopped?: boolean;
    stoppedOlderThanDays?: number;
    confirm?: boolean;
    allWorkspaces?: boolean;
  } = {},
): Promise<{ removed: RegistryRecord[]; wouldRemove: RegistryRecord[] }> {
  const {
    // lostOlderThanDays is the canonical name; olderThanDays is kept as a
    // deprecated alias for one release (mapped, not dropped).
    lostOlderThanDays = options.olderThanDays ?? 7,
    includeStopped = false,
    stoppedOlderThanDays = 30,
    confirm = false,
    allWorkspaces = false,
  } = options;

  // Reconcile first: demote never-live records to lost so the age rules below
  // can reach them. Without this, phantom managed_active records are invisible
  // to prune forever.
  const [hcomAgents, stoppedNames] = await Promise.all([
    listHcomAgents(),
    listStoppedAgentNames(),
  ]);
  const registry = loadRegistry();
  const reconciled = reconcileManagedRecords(registry.records, hcomAgents, stoppedNames);
  persistReconciledState(registry.records, reconciled);

  const now = Date.now();

  const lostStates: OwnershipState[] = ["managed_lost", "adopted_lost"];
  const stoppedStates: OwnershipState[] = ["managed_stopped", "adopted_stopped"];
  const protectedStates: OwnershipState[] = ["managed_active", "adopted_active", "managed_released", "managed_blocked"];

  const workspaceRecords = allWorkspaces
    ? reconciled
    : reconciled.filter((r) => r.workspace === workspace);

  function isOlderThan(record: RegistryRecord, days: number): boolean {
    const lastSeen = new Date(record.lastSeenAt).getTime();
    return now - lastSeen > days * 24 * 60 * 60 * 1000;
  }

  const toRemove: RegistryRecord[] = [];

  for (const record of workspaceRecords) {
    // Never prune active/released/blocked records
    if (protectedStates.includes(record.state)) continue;

    if (lostStates.includes(record.state) && isOlderThan(record, lostOlderThanDays)) {
      toRemove.push(record);
    } else if (includeStopped && stoppedStates.includes(record.state) && isOlderThan(record, stoppedOlderThanDays)) {
      toRemove.push(record);
    }
  }

  if (confirm) {
    const removeIds = new Set(toRemove.map((r) => r.id));
    registry.records = registry.records.filter((r) => !removeIds.has(r.id));
    saveRegistry(registry);
    return { removed: toRemove, wouldRemove: [] };
  }

  return { removed: [], wouldRemove: toRemove };
}
