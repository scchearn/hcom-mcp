import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { findLiveAgentByIdentifier, listHcomAgents, listStoppedAgentNames } from "./hcom.js";
import {
  RegistryRecordSchema,
  type RegistryRecord,
  type OwnershipState,
  type Harness,
  type HcomAgent,
  type LaunchMode,
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
    // Heal the live file so the bad records are not re-quarantined on every
    // load. If the heal-write itself fails (disk full, permissions), surface
    // the informative RegistryError with the quarantine path instead of a raw
    // FS error: the corrupt data is already preserved, so the caller must
    // still learn where it went.
    try {
      saveRegistry({ records });
    } catch (err: any) {
      throw new RegistryError(
        `Registry at ${REGISTRY_PATH} contained ${bad.length} invalid record(s) and the heal-write failed: ${err.message}. ` +
          `Invalid records were quarantined to ${quarantinePath}.`,
        quarantinePath,
      );
    }
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
export function addRecord(
  record: Omit<RegistryRecord, "id" | "createdAt" | "lastSeenAt" | "requireReport"> & {
    requireReport?: boolean;
  },
): RegistryRecord {
  const registry = loadRegistry();
  const now = new Date().toISOString();
  const full: RegistryRecord = {
    ...record,
    requireReport: record.requireReport ?? false,
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
 * `touch` controls whether lastSeenAt is bumped: lifecycle operations (stop,
 * kill, verify) are user-visible activity and should touch; reconcile-driven
 * transitions must NOT touch, or every demotion resets the age clock that
 * prune's age rules depend on.
 */
export function updateRecordState(id: string, state: OwnershipState, touch: boolean = true): RegistryRecord | null {
  const registry = loadRegistry();
  const record = registry.records.find((r) => r.id === id);
  if (!record) return null;
  record.state = state;
  if (touch) record.lastSeenAt = new Date().toISOString();
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
 * Reconcile a resumed agent into its retained ownership record.
 *
 * Resume keeps the hcom identity, so appending a second record for the same
 * session makes lifecycle ownership ambiguous. Update the source record
 * atomically and release only duplicates with the same retained session. A
 * recycled hcom name with a different session is a different agent and must
 * remain owned and auditable.
 */
export function upsertResumedRecord(
  id: string,
  updates: {
    hcomName?: string;
    sessionId?: string;
    launchMode?: LaunchMode;
    state?: OwnershipState;
    resumedFrom?: string;
    requireReport?: boolean;
    dispatchAt?: string;
  },
): RegistryRecord | null {
  const registry = loadRegistry();
  const record = registry.records.find((candidate) => candidate.id === id);
  if (!record) return null;

  const resumedSessionId = updates.sessionId ?? record.sessionId;
  const now = new Date().toISOString();
  if (resumedSessionId) {
    for (const candidate of registry.records) {
      if (
        candidate.id !== id &&
        !candidate.released &&
        candidate.workspace === record.workspace &&
        candidate.sessionId === resumedSessionId
      ) {
        candidate.released = true;
        candidate.lastSeenAt = now;
      }
    }
  }

  Object.assign(record, updates);
  record.released = false;
  record.lastSeenAt = now;
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
    requireReport: false,
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
 * Match a record to a live hcom agent by its stored base/display name.
 * Purely name-based: directory and session data are NOT filters here (a
 * record's workspace is often a service home or a parent of the agent's
 * real directory, so filtering would false-demote live agents). Name
 * collisions between records are arbitrated in reconcileManagedRecords.
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
 * True when a record's expiresAt has passed. Records without expiresAt never
 * expire.
 */
export function isRecordExpired(record: RegistryRecord, now: number = Date.now()): boolean {
  if (!record.expiresAt) return false;
  const expiry = new Date(record.expiresAt).getTime();
  return Number.isFinite(expiry) && now > expiry;
}

/**
 * Settle registry records against live hcom state. This is the single
 * live-vs-record truth engine: it demotes never-live records to lost, promotes
 * stopped/blocked records that are live again, and flags expired ephemeral
 * records. `stoppedNames` (from `hcom list --stopped`) lets a record that
 * stopped cleanly stay stopped instead of being demoted to lost.
 *
 * Expired records are flagged with state "managed_expired" (or
 * "adopted_expired" for adopted records) so prune's expired mode can find
 * them; the state is a flag, not a lifecycle claim — the agent may still be
 * alive and is killed by prune expired=true.
 *
 * Contested-name arbitration: CVCV names are reused, so several unreleased
 * records can share one hcomName while only one live agent exists. When a
 * name is contested, directory equality is the tie-breaker — the record
 * whose workspace IS the live agent's directory keeps the match and its
 * rivals are treated as unmatched this pass. If no record can prove
 * ownership by directory, everyone keeps the plain name match: ambiguity
 * must never mass-demote. Single-record names are untouched, so a record
 * whose workspace is a service home or a parent of the agent's real
 * directory still matches normally.
 */
export function reconcileManagedRecords(
  records: RegistryRecord[],
  hcomAgents: HcomAgent[],
  stoppedNames: string[] = [],
): RegistryRecord[] {
  const nameCounts = new Map<string, number>();
  for (const record of records) {
    if (!record.released && record.hcomName) {
      nameCounts.set(record.hcomName, (nameCounts.get(record.hcomName) ?? 0) + 1);
    }
  }
  const contested = new Set(
    [...nameCounts.entries()].filter(([, count]) => count > 1).map(([name]) => name),
  );

  const matchLive = (record: RegistryRecord): HcomAgent | null => {
    const live = matchLiveAgent(record, hcomAgents);
    if (!live || !record.hcomName || !contested.has(record.hcomName)) return live;
    const provenOwner = records.some(
      (r) =>
        !r.released &&
        r.hcomName === record.hcomName &&
        r.workspace !== undefined &&
        r.workspace === live.directory,
    );
    if (!provenOwner) return live;
    return record.workspace === live.directory ? live : null;
  };

  return records.map((record) => {
    if (record.released || !record.hcomName) {
      return record;
    }

    // Expiry wins over every other transition: an expired ephemeral worker
    // must be flagged regardless of what hcom currently reports. Lost records
    // are exempt — they are already in the lost-prune path, and flagging them
    // expired would force callers to use expired=true instead of the normal
    // age rules.
    if (isRecordExpired(record) && record.state !== "managed_lost" && record.state !== "adopted_lost") {
      const expiredState = record.state.startsWith("adopted_") ? "adopted_expired" : "managed_expired";
      if (record.state === expiredState) return record;
      return { ...record, state: expiredState as OwnershipState };
    }

    // A flagged-expired record whose expiresAt was removed or extended reverts
    // to the live-vs-lost truth instead of staying *_expired forever.
    if (record.state === "managed_expired" || record.state === "adopted_expired") {
      const liveAgent = matchLive(record);
      const activeState = record.state === "managed_expired" ? "managed_active" : "adopted_active";
      const lostState = record.state === "managed_expired" ? "managed_lost" : "adopted_lost";
      return { ...record, state: (liveAgent ? activeState : lostState) as OwnershipState };
    }

    const liveAgent = matchLive(record);

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
 * A state change produced by reconciling: record `id` moved from `from` to
 * `to`. Keyed by id (not array index) so a future filter/sort inside
 * reconcileManagedRecords can never silently misattribute a transition.
 */
export interface ReconcileTransition {
  id: string;
  from: OwnershipState;
  to: OwnershipState;
}

/**
 * Diff two record sets by id. Both sides must come from the same reconcile
 * pass (before = input records, after = their reconciled counterparts).
 */
export function diffReconciledState(
  before: RegistryRecord[],
  after: RegistryRecord[],
): ReconcileTransition[] {
  const beforeById = new Map(before.map((record) => [record.id, record]));
  const transitions: ReconcileTransition[] = [];
  for (const record of after) {
    const prev = beforeById.get(record.id);
    if (prev && prev.state !== record.state) {
      transitions.push({ id: record.id, from: prev.state, to: record.state });
    }
  }
  return transitions;
}

/**
 * Persist reconcile transitions in ONE registry load + ONE atomic write.
 * Per-transition load/save would be O(transitions × records) on a global
 * pass over a large registry and would widen the accepted lost-update race
 * window with every write; a mid-loop load failure could also leave the
 * pass half-persisted.
 *
 * Transitions are bookkeeping, not user activity: lastSeenAt is not
 * touched, or every demotion resets the age clock that prune's age rules
 * depend on.
 */
export function persistReconciledTransitions(transitions: ReconcileTransition[]): void {
  if (transitions.length === 0) return;
  const registry = loadRegistry();
  const byId = new Map(registry.records.map((record) => [record.id, record]));
  for (const transition of transitions) {
    const record = byId.get(transition.id);
    if (record) record.state = transition.to;
  }
  saveRegistry(registry);
}

/**
 * Thin wrapper for existing before/after callers (list_managed, prune):
 * diff by id and batch-persist the result.
 */
export function persistReconciledState(before: RegistryRecord[], after: RegistryRecord[]) {
  persistReconciledTransitions(diffReconciledState(before, after));
}

/**
 * Resolve the root launcher of a record's resume/fork chain: follow
 * resumedFrom links (record id for resumes, hcom name for forks) back to
 * the origin record and return ITS launchedBy. Ambiguous or missing links
 * stop the walk early (conservative); cycles are broken by a visited set.
 */
export function resolveRootLauncher(
  record: Pick<RegistryRecord, "id" | "launchedBy" | "resumedFrom">,
  records: RegistryRecord[],
): string | undefined {
  const visited = new Set<string>([record.id]);
  let current: Pick<RegistryRecord, "id" | "launchedBy" | "resumedFrom"> = record;
  for (let depth = 0; depth < 32; depth++) {
    const ref = current.resumedFrom;
    if (!ref) break;
    let parent = records.find((r) => r.id === ref && !visited.has(r.id));
    if (!parent) {
      // Fork provenance stores the source agent NAME; only follow it when
      // exactly one candidate exists, never guess between namesakes.
      const nameMatches = records.filter((r) => r.hcomName === ref && !visited.has(r.id));
      parent = nameMatches.length === 1 ? nameMatches[0] : undefined;
    }
    if (!parent) break;
    visited.add(parent.id);
    current = parent;
  }
  return current.launchedBy ?? record.launchedBy;
}

/**
 * Reconcile EVERY non-released owned record against live hcom state,
 * regardless of workspace, and persist any state transitions in one batched
 * write.
 *
 * Workspace-scoped reconcile only healed the workspace a caller happens to
 * target, so records stranded in deleted worktree workspaces stayed
 * managed_active forever while hcom reported only a handful of live agents.
 * This global pass fetches live state once and settles all owned records.
 *
 * ponytail: owned records with no hcomName (legacy launches that died
 * before hcom assigned a name — none are written today) pass through
 * untouched and are never demoted; they stay invisible to prune's lost-age
 * rules. Count them honestly rather than pretending they are healed.
 *
 * `prefetch` lets a caller that already holds a live snapshot (status, the
 * M2 sweep) reuse it instead of paying for a second `hcom list`; the
 * returned liveAgents/stoppedNames let the same caller skip a third fetch.
 */
export async function reconcileGlobalRecords(prefetch?: {
  hcomAgents: HcomAgent[];
  stoppedNames: string[];
}): Promise<{
  records: RegistryRecord[];
  transitions: ReconcileTransition[];
  liveAgents: HcomAgent[];
  stoppedNames: string[];
}> {
  const registry = loadRegistry();
  const owned = registry.records.filter((r) => !r.released);
  const [hcomAgents, stoppedNames] = prefetch
    ? [prefetch.hcomAgents, prefetch.stoppedNames]
    : await Promise.all([listHcomAgents(), listStoppedAgentNames()]);
  const reconciled = reconcileManagedRecords(owned, hcomAgents, stoppedNames);
  const transitions = diffReconciledState(owned, reconciled);
  persistReconciledTransitions(transitions);
  return { records: reconciled, transitions, liveAgents: hcomAgents, stoppedNames };
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
    expired?: boolean;
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
    expired = false,
  } = options;

  // Reconcile first: demote never-live records to lost (and flag expired
  // ephemeral records) so the age rules below can reach them. Without this,
  // phantom managed_active records are invisible to prune forever.
  // Deliberate policy, not a global invariant: prune only reconciles the
  // records in scope so a caller pruning workspace A never silently mutates
  // workspace B record states. Cross-workspace healing lives in
  // reconcileGlobalRecords (wired into status), which reconciles every
  // owned record regardless of workspace.
  const [hcomAgents, stoppedNames] = await Promise.all([
    listHcomAgents(),
    listStoppedAgentNames(),
  ]);
  const registry = loadRegistry();
  const scopedRecords = allWorkspaces
    ? registry.records
    : registry.records.filter((r) => r.workspace === workspace);
  const reconciled = reconcileManagedRecords(scopedRecords, hcomAgents, stoppedNames);
  persistReconciledState(scopedRecords, reconciled);

  const now = Date.now();

  const lostStates: OwnershipState[] = ["managed_lost", "adopted_lost"];
  const stoppedStates: OwnershipState[] = ["managed_stopped", "adopted_stopped"];
  const expiredStates: OwnershipState[] = ["managed_expired", "adopted_expired"];
  const protectedStates: OwnershipState[] = ["managed_active", "adopted_active", "managed_released", "managed_blocked"];

  const workspaceRecords = reconciled;

  function isOlderThan(record: RegistryRecord, days: number): boolean {
    const lastSeen = new Date(record.lastSeenAt).getTime();
    return now - lastSeen > days * 24 * 60 * 60 * 1000;
  }

  const toRemove: RegistryRecord[] = [];

  for (const record of workspaceRecords) {
    // Never prune active/released/blocked records
    if (protectedStates.includes(record.state)) continue;

    // expired=true is an exclusive mode: only expired ephemeral records are
    // targeted, so the kill+clear workflow never accidentally removes records
    // the caller did not ask for.
    if (expired) {
      if (expiredStates.includes(record.state)) toRemove.push(record);
      continue;
    }

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
