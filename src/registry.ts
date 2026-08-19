import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  RegistryRecordSchema,
  type RegistryRecord,
  type OwnershipState,
  type Harness,
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
 * Prune stale registry records based on state and age.
 * Returns the list of records that would be (or were) removed.
 */
export function pruneRecords(
  workspace: string,
  options: {
    olderThanDays?: number;
    includeStopped?: boolean;
    stoppedOlderThanDays?: number;
    confirm?: boolean;
  } = {},
): { removed: RegistryRecord[]; wouldRemove: RegistryRecord[] } {
  const {
    olderThanDays = 7,
    includeStopped = false,
    stoppedOlderThanDays = 30,
    confirm = false,
  } = options;

  const registry = loadRegistry();
  const now = Date.now();

  const lostStates: OwnershipState[] = ["managed_lost", "adopted_lost"];
  const stoppedStates: OwnershipState[] = ["managed_stopped", "adopted_stopped"];
  const protectedStates: OwnershipState[] = ["managed_active", "adopted_active", "managed_released", "managed_blocked"];

  const workspaceRecords = registry.records.filter((r) => r.workspace === workspace);

  function isOlderThan(record: RegistryRecord, days: number): boolean {
    const lastSeen = new Date(record.lastSeenAt).getTime();
    return now - lastSeen > days * 24 * 60 * 60 * 1000;
  }

  const toRemove: RegistryRecord[] = [];

  for (const record of workspaceRecords) {
    // Never prune active/released/blocked records
    if (protectedStates.includes(record.state)) continue;

    if (lostStates.includes(record.state) && isOlderThan(record, olderThanDays)) {
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
