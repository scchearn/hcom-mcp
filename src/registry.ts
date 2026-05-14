import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  RegistryRecordSchema,
  type RegistryRecord,
  type OwnershipState,
} from "./types.js";

const REGISTRY_DIR = join(homedir(), ".local", "share", "hcom-bootstrap");
const REGISTRY_PATH = join(REGISTRY_DIR, "registry.json");

interface Registry {
  records: RegistryRecord[];
}

function loadRegistry(): Registry {
  if (!existsSync(REGISTRY_PATH)) {
    return { records: [] };
  }
  try {
    const raw = readFileSync(REGISTRY_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    return { records: (parsed.records ?? []).map((r: any) => RegistryRecordSchema.parse(r)) };
  } catch {
    return { records: [] };
  }
}

function saveRegistry(registry: Registry): void {
  if (!existsSync(REGISTRY_DIR)) {
    mkdirSync(REGISTRY_DIR, { recursive: true });
  }
  writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2), "utf-8");
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
    (r) => !r.released && r.state !== "managed_lost"
  );
}