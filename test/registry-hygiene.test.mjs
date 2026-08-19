import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as realFs from 'node:fs';

let importCounter = 0;

async function loadRegistryModule() {
  importCounter += 1;
  return import(`../dist/registry.js?${importCounter}`);
}

function makeRecord(overrides = {}) {
  return {
    id: 'rec-1',
    workspace: '/repo',
    harness: 'opencode',
    hcomName: 'waka',
    preset: 'adhoc',
    launchMode: 'headless',
    state: 'managed_active',
    createdAt: '2026-08-01T00:00:00.000Z',
    lastSeenAt: '2026-08-01T00:00:00.000Z',
    released: false,
    ...overrides,
  };
}

function mockHcom(t, { liveAgents = [], stoppedNames = [] } = {}) {
  t.mock.module('../dist/hcom.js', {
    namedExports: {
      listHcomAgents: async () => liveAgents,
      listStoppedAgentNames: async () => stoppedNames,
      findLiveAgentByIdentifier: (id, agents) =>
        agents.find((a) => a.name === id || a.base_name === id) ?? null,
    },
  });
}

function seedRegistry(home, records) {
  const registryPath = join(home, '.hcom', 'mcp', 'registry.json');
  realFs.mkdirSync(join(home, '.hcom', 'mcp'), { recursive: true });
  writeFileSync(registryPath, JSON.stringify({ records }), 'utf-8');
  return registryPath;
}

function readRegistry(home) {
  return JSON.parse(readFileSync(join(home, '.hcom', 'mcp', 'registry.json'), 'utf-8'));
}

// --- #13: reconcile-first prune ---

test('prune reconciles first: a phantom managed_active record is demoted to lost and pruned', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'hcom-prune-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  t.mock.module('node:os', { namedExports: { homedir: () => home } });
  mockHcom(t, { live: [], stoppedNames: [] });

  const reg = await loadRegistryModule();
  // Phantom: recorded active but never live in hcom, and old.
  seedRegistry(home, [
    makeRecord({
      id: 'phantom-1',
      state: 'managed_active',
      lastSeenAt: '2026-01-01T00:00:00.000Z',
    }),
  ]);

  const result = await reg.pruneRecords('/repo', { lostOlderThanDays: 7 });

  // Reconcile demoted it to managed_lost, so the age rule can reach it.
  assert.equal(result.wouldRemove.length, 1);
  assert.equal(result.wouldRemove[0].id, 'phantom-1');
  assert.equal(result.wouldRemove[0].state, 'managed_lost');
});

test('prune confirm removes reconciled-lost records from the registry', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'hcom-prune-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  t.mock.module('node:os', { namedExports: { homedir: () => home } });
  // waka is live: its record stays protected through reconcile.
  mockHcom(t, {
    liveAgents: [{ name: 'waka', base_name: 'waka', status: 'listening' }],
    stoppedNames: [],
  });

  const reg = await loadRegistryModule();
  seedRegistry(home, [
    makeRecord({ id: 'phantom-1', hcomName: 'ghost', state: 'managed_active', lastSeenAt: '2026-01-01T00:00:00.000Z' }),
    makeRecord({ id: 'live-1', state: 'managed_active', lastSeenAt: '2026-08-01T00:00:00.000Z' }),
  ]);

  const result = await reg.pruneRecords('/repo', { lostOlderThanDays: 7, confirm: true });

  assert.equal(result.removed.length, 1);
  assert.equal(result.removed[0].id, 'phantom-1');
  const after = readRegistry(home);
  assert.deepEqual(after.records.map((r) => r.id), ['live-1']);
});

test('prune never touches protected states even when old', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'hcom-prune-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  t.mock.module('node:os', { namedExports: { homedir: () => home } });
  // waka is live, so its active/blocked records stay protected through
  // reconcile; released records are never reconciled.
  mockHcom(t, {
    liveAgents: [{ name: 'waka', base_name: 'waka', status: 'listening' }],
    stoppedNames: [],
  });

  const reg = await loadRegistryModule();
  seedRegistry(home, [
    makeRecord({ id: 'active-1', state: 'managed_active', lastSeenAt: '2026-01-01T00:00:00.000Z' }),
    makeRecord({ id: 'released-1', state: 'managed_released', released: true, lastSeenAt: '2026-01-01T00:00:00.000Z' }),
    makeRecord({ id: 'blocked-1', state: 'managed_blocked', lastSeenAt: '2026-01-01T00:00:00.000Z' }),
  ]);

  const result = await reg.pruneRecords('/repo', { lostOlderThanDays: 7 });
  assert.equal(result.wouldRemove.length, 0);
});

// --- #13: stopped vs lost via `hcom list --stopped` ---

test('reconcile keeps a stopped record stopped when the agent stopped cleanly', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'hcom-prune-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  t.mock.module('node:os', { namedExports: { homedir: () => home } });
  mockHcom(t, { live: [], stoppedNames: ['waka'] });

  const reg = await loadRegistryModule();
  const records = [makeRecord({ id: 'stopped-1', state: 'managed_stopped' })];
  const reconciled = reg.reconcileManagedRecords(records, [], ['waka']);
  assert.equal(reconciled[0].state, 'managed_stopped');
});

test('reconcile demotes a stopped record to lost when the agent vanished without a clean stop', () => {
  // Pure function test (no fs): stopped record, agent neither live nor stopped.
  // Loaded via the module cache from the previous test's mock — the pure
  // reconcile path does not touch hcom, so this is safe.
  return import(`../dist/registry.js?${importCounter++}`).then((reg) => {
    const records = [makeRecord({ id: 'stopped-1', state: 'managed_stopped' })];
    const reconciled = reg.reconcileManagedRecords(records, [], []);
    assert.equal(reconciled[0].state, 'managed_lost');
  });
});

// --- #10: TTL / ephemeral workers ---

test('prune allWorkspaces=true targets records across every workspace', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'hcom-prune-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  t.mock.module('node:os', { namedExports: { homedir: () => home } });
  mockHcom(t, { live: [], stoppedNames: [] });

  const reg = await loadRegistryModule();
  seedRegistry(home, [
    makeRecord({ id: 'a-1', workspace: '/ws-a', state: 'managed_lost', lastSeenAt: '2026-01-01T00:00:00.000Z' }),
    makeRecord({ id: 'b-1', workspace: '/ws-b', state: 'managed_lost', lastSeenAt: '2026-01-01T00:00:00.000Z' }),
  ]);

  const scoped = await reg.pruneRecords('/ws-a', { lostOlderThanDays: 7 });
  assert.deepEqual(scoped.wouldRemove.map((r) => r.id), ['a-1']);

  const all = await reg.pruneRecords('/ws-a', { lostOlderThanDays: 7, allWorkspaces: true });
  assert.deepEqual(all.wouldRemove.map((r) => r.id).sort(), ['a-1', 'b-1']);
});

test('prune accepts the deprecated olderThanDays alias for lostOlderThanDays', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'hcom-prune-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  t.mock.module('node:os', { namedExports: { homedir: () => home } });
  mockHcom(t, { live: [], stoppedNames: [] });

  const reg = await loadRegistryModule();
  seedRegistry(home, [
    makeRecord({ id: 'old-1', state: 'managed_lost', lastSeenAt: '2026-01-01T00:00:00.000Z' }),
  ]);

  const result = await reg.pruneRecords('/repo', { olderThanDays: 7 });
  assert.equal(result.wouldRemove.length, 1);
});

// --- Deferred LOW: heal-write failure surfaces RegistryError ---
test('status reports the hcom version and the full state breakdown', async (t) => {
  t.mock.module('../dist/hcom.js', {
    namedExports: {
      listHcomAgents: async () => [{ name: 'waka', base_name: 'waka', status: 'listening' }],
      listStoppedAgentNames: async () => [],
      execHcom: async (args) => {
        assert.deepEqual(args, ['--version']);
        return { exitCode: 0, stdout: 'hcom 0.7.25', stderr: '' };
      },
    },
  });
  t.mock.module('../dist/registry.js', {
    namedExports: {
      getRecordsByWorkspace: () => [
        { id: 'a', state: 'managed_active' },
        { id: 'b', state: 'adopted_lost' },
        { id: 'c', state: 'adopted_lost' },
        { id: 'd', state: 'managed_released', released: true },
      ],
      getOwnedRecordsByWorkspace: () => [],
      reconcileWorkspaceRecords: async () => [
        { id: 'a', state: 'managed_active' },
        { id: 'b', state: 'adopted_lost' },
        { id: 'c', state: 'adopted_lost' },
      ],
      matchLiveAgent: () => null,
      persistReconciledState: () => {},
      reconcileManagedRecords: (records) => records,
    },
  });
  t.mock.module('../dist/config.js', {
    namedExports: {
      loadMergedConfig: () => ({ agentPresets: { p: {} }, topologyPresets: {} }),
      getConfigPaths: () => ({ registry: { path: '/tmp/registry.json', exists: true } }),
      summarizeAgentPresets: () => [],
      summarizeTopologyPresets: () => [],
    },
  });

  const { registerStatusTool } = await import(`../dist/tools/list.js?${importCounter++}`);
  const server = {
    names: [],
    handlers: new Map(),
    tool(name, _desc, _schema, handler) {
      this.names.push(name);
      this.handlers.set(name, handler);
    },
  };
  registerStatusTool(server);

  const response = await server.handlers.get('status')({ workspace: '/repo' });
  assert.equal(response.isError, undefined);
  const payload = JSON.parse(response.content[0].text);
  assert.equal(payload.hcomVersion, 'hcom 0.7.25');
  assert.equal(payload.hcomAvailable, true);
  // adopted_lost is the largest stale bucket in the wild — it must be visible.
  assert.deepEqual(payload.stateBreakdown, {
    managed_active: 1,
    adopted_lost: 2,
    managed_released: 1,
  });
  assert.equal(payload.managedReleasedCount, 1);
});

test('status reports hcomVersion null when the CLI version check fails', async (t) => {
  t.mock.module('../dist/hcom.js', {
    namedExports: {
      listHcomAgents: async () => [],
      listStoppedAgentNames: async () => [],
      execHcom: async () => ({ exitCode: 1, stdout: '', stderr: 'not found' }),
    },
  });
  t.mock.module('../dist/registry.js', {
    namedExports: {
      getRecordsByWorkspace: () => [],
      getOwnedRecordsByWorkspace: () => [],
      reconcileWorkspaceRecords: async () => [],
      matchLiveAgent: () => null,
      persistReconciledState: () => {},
      reconcileManagedRecords: (records) => records,
    },
  });
  t.mock.module('../dist/config.js', {
    namedExports: {
      loadMergedConfig: () => ({ agentPresets: {}, topologyPresets: {} }),
      getConfigPaths: () => ({}),
      summarizeAgentPresets: () => [],
      summarizeTopologyPresets: () => [],
    },
  });

  const { registerStatusTool } = await import(`../dist/tools/list.js?${importCounter++}`);
  const server = {
    names: [],
    handlers: new Map(),
    tool(name, _desc, _schema, handler) {
      this.names.push(name);
      this.handlers.set(name, handler);
    },
  };
  registerStatusTool(server);

  const response = await server.handlers.get('status')({ workspace: '/repo' });
  const payload = JSON.parse(response.content[0].text);
  assert.equal(payload.hcomVersion, null);
});

// --- #10: launch ttl_minutes persists expiresAt ---

test('prune tool defaults to a summary without full records unless verbose', async (t) => {
  t.mock.module('../dist/hcom.js', {
    namedExports: {
      execHcom: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    },
  });
  t.mock.module('../dist/registry.js', {
    namedExports: {
      pruneRecords: async () => ({
        removed: [],
        wouldRemove: [{ id: 'lost-1', hcomName: 'waka', state: 'managed_lost' }],
      }),
    },
  });

  const { registerPruneTool } = await import(`../dist/tools/prune.js?${importCounter++}`);
  const server = {
    names: [],
    handlers: new Map(),
    tool(name, _desc, _schema, handler) {
      this.names.push(name);
      this.handlers.set(name, handler);
    },
  };
  registerPruneTool(server);

  const summary = await server.handlers.get('prune')({ workspace: '/repo' });
  const summaryPayload = JSON.parse(summary.content[0].text);
  assert.equal(summaryPayload.records, undefined);
  assert.equal(summaryPayload.count, 1);

  const verbose = await server.handlers.get('prune')({ workspace: '/repo', verbose: true });
  const verbosePayload = JSON.parse(verbose.content[0].text);
  assert.equal(verbosePayload.records.length, 1);
});

// --- #13: status tool ---

