import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
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

// Full HcomAgentSchema shape — thin {name, base_name, status} fixtures are
// exactly what hides directory/session match regressions from the suite.
function liveAgent(overrides = {}) {
  return {
    name: 'waka',
    base_name: 'waka',
    status: 'listening',
    status_age_seconds: 12,
    unread_count: 0,
    tool: 'opencode',
    tag: null,
    directory: '/repo',
    session_id: 'ses_live000001',
    headless: true,
    ...overrides,
  };
}

function mockHcom(t, { liveAgents = [], stoppedNames = [], counters } = {}) {
  t.mock.module('../dist/hcom.js', {
    namedExports: {
      listHcomAgents: async () => {
        if (counters) counters.listCalls += 1;
        return liveAgents;
      },
      listStoppedAgentNames: async () => {
        if (counters) counters.stoppedCalls += 1;
        return stoppedNames;
      },
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

function byId(records) {
  return Object.fromEntries(records.map((r) => [r.id, r]));
}

// --- Phase 0: global reconcile across all workspaces ---

test('reconcileGlobalRecords demotes phantom active records in dead worktree workspaces with one live-state fetch', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'hcom-global-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  t.mock.module('node:os', { namedExports: { homedir: () => home } });
  // Only waka is live: vade and nute's worktrees are long gone.
  const counters = { listCalls: 0, stoppedCalls: 0 };
  mockHcom(t, {
    liveAgents: [liveAgent()],
    stoppedNames: [],
    counters,
  });

  const reg = await loadRegistryModule();
  seedRegistry(home, [
    makeRecord({ id: 'w2-1', workspace: '/repo-w2', hcomName: 'vade' }),
    makeRecord({ id: 'w5-1', workspace: '/repo-w5', hcomName: 'nute' }),
    makeRecord({ id: 'live-1', workspace: '/repo', hcomName: 'waka' }),
  ]);

  const { records, transitions } = await reg.reconcileGlobalRecords();

  const recs = byId(records);
  // Records no tool call would ever target are healed by the global pass.
  assert.equal(recs['w2-1'].state, 'managed_lost');
  assert.equal(recs['w5-1'].state, 'managed_lost');
  assert.equal(recs['live-1'].state, 'managed_active');
  // Transitions are id-keyed objects, not a count derived from array index.
  assert.deepEqual(
    transitions.map((tr) => ({ id: tr.id, from: tr.from, to: tr.to })).sort((a, b) => a.id.localeCompare(b.id)),
    [
      { id: 'w2-1', from: 'managed_active', to: 'managed_lost' },
      { id: 'w5-1', from: 'managed_active', to: 'managed_lost' },
    ],
  );
  // One live-state fetch per pass, not per record or per workspace.
  assert.equal(counters.listCalls, 1);
  assert.equal(counters.stoppedCalls, 1);

  const persisted = byId(readRegistry(home).records);
  assert.equal(persisted['w2-1'].state, 'managed_lost');
  assert.equal(persisted['live-1'].state, 'managed_active');
});

test('reconcileGlobalRecords accepts a prefetch snapshot and skips live-state fetches', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'hcom-global-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  t.mock.module('node:os', { namedExports: { homedir: () => home } });
  const counters = { listCalls: 0, stoppedCalls: 0 };
  mockHcom(t, { liveAgents: [liveAgent()], stoppedNames: [], counters });

  const reg = await loadRegistryModule();
  seedRegistry(home, [
    makeRecord({ id: 'live-1', hcomName: 'waka' }),
    makeRecord({ id: 'phantom-1', hcomName: 'vade' }),
  ]);

  const prefetch = { hcomAgents: [liveAgent()], stoppedNames: [] };
  const { records, liveAgents, stoppedNames } = await reg.reconcileGlobalRecords(prefetch);

  assert.equal(counters.listCalls, 0);
  assert.equal(counters.stoppedCalls, 0);
  // The snapshot is echoed back so callers (status, the M2 sweep) can reuse
  // it instead of paying for a third fetch.
  assert.deepEqual(liveAgents, prefetch.hcomAgents);
  assert.deepEqual(stoppedNames, []);
  assert.equal(byId(records)['phantom-1'].state, 'managed_lost');
});

test('reconcileGlobalRecords skips released records and preserves lastSeenAt', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'hcom-global-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  t.mock.module('node:os', { namedExports: { homedir: () => home } });
  mockHcom(t, { liveAgents: [], stoppedNames: [] });

  const reg = await loadRegistryModule();
  seedRegistry(home, [
    makeRecord({
      id: 'released-1',
      hcomName: 'ghost',
      state: 'managed_released',
      released: true,
      lastSeenAt: '2026-05-01T00:00:00.000Z',
    }),
    makeRecord({
      id: 'phantom-1',
      hcomName: 'vade',
      state: 'managed_active',
      lastSeenAt: '2026-06-01T00:00:00.000Z',
    }),
  ]);

  const { records, transitions } = await reg.reconcileGlobalRecords();

  // Released records are not part of the reconciled set at all.
  assert.deepEqual(records.map((r) => r.id), ['phantom-1']);
  assert.deepEqual(transitions, [{ id: 'phantom-1', from: 'managed_active', to: 'managed_lost' }]);

  const persisted = byId(readRegistry(home).records);
  assert.equal(persisted['released-1'].state, 'managed_released');
  // Released records are not reconciled or rewritten.
  assert.equal(persisted['released-1'].lastSeenAt, '2026-05-01T00:00:00.000Z');
  // Reconcile transitions are bookkeeping: lastSeenAt (the prune age clock)
  // must not move, or every demotion resets prune's reach.
  assert.equal(persisted['phantom-1'].lastSeenAt, '2026-06-01T00:00:00.000Z');
});

test('reconcileGlobalRecords keeps cleanly-stopped records in any workspace stopped', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'hcom-global-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  t.mock.module('node:os', { namedExports: { homedir: () => home } });
  mockHcom(t, { liveAgents: [], stoppedNames: ['waka'] });

  const reg = await loadRegistryModule();
  seedRegistry(home, [
    makeRecord({ id: 'stopped-w3', workspace: '/repo-w3', hcomName: 'waka', state: 'managed_stopped' }),
    makeRecord({ id: 'vanished-w4', workspace: '/repo-w4', hcomName: 'zago', state: 'managed_stopped' }),
  ]);

  const { records } = await reg.reconcileGlobalRecords();

  assert.equal(byId(records)['stopped-w3'].state, 'managed_stopped');
  assert.equal(byId(records)['vanished-w4'].state, 'managed_lost');
  // The stopped-vs-lost distinction is persisted, not just returned.
  const persisted = byId(readRegistry(home).records);
  assert.equal(persisted['stopped-w3'].state, 'managed_stopped');
  assert.equal(persisted['vanished-w4'].state, 'managed_lost');
});

test('reconcileGlobalRecords reverts flagged-expired records when the expiry is lifted', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'hcom-global-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  t.mock.module('node:os', { namedExports: { homedir: () => home } });
  mockHcom(t, { liveAgents: [liveAgent()], stoppedNames: [] });

  const reg = await loadRegistryModule();
  seedRegistry(home, [
    // Flagged expired once; expiresAt since removed/extended. Live again ->
    // back to active. This branch can flip a record in BOTH directions.
    makeRecord({ id: 'revive-1', hcomName: 'waka', state: 'managed_expired' }),
    makeRecord({ id: 'gone-1', workspace: '/repo-x', hcomName: 'zago', state: 'managed_expired' }),
  ]);

  const { records } = await reg.reconcileGlobalRecords();

  assert.equal(byId(records)['revive-1'].state, 'managed_active');
  assert.equal(byId(records)['gone-1'].state, 'managed_lost');
});

// --- M3-as-revised: contested-name arbitration by directory equality ---

test('contested names arbitrate: the record whose workspace equals the agent directory keeps the match', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'hcom-global-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  t.mock.module('node:os', { namedExports: { homedir: () => home } });
  mockHcom(t, {
    liveAgents: [liveAgent({ directory: '/repo-a' })],
    stoppedNames: [],
  });

  const reg = await loadRegistryModule();
  seedRegistry(home, [
    makeRecord({ id: 'real-1', workspace: '/repo-a', hcomName: 'waka' }),
    makeRecord({ id: 'stale-1', workspace: '/repo-b', hcomName: 'waka' }),
  ]);

  const { records } = await reg.reconcileGlobalRecords();

  assert.equal(byId(records)['real-1'].state, 'managed_active');
  assert.equal(byId(records)['stale-1'].state, 'managed_lost');
});

test('contested names with no directory proof keep the plain name match for everyone', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'hcom-global-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  t.mock.module('node:os', { namedExports: { homedir: () => home } });
  // The agent's directory matches NEITHER record: ambiguity must never
  // mass-demote, so both keep the name match (status quo).
  mockHcom(t, {
    liveAgents: [liveAgent({ directory: '/somewhere-else' })],
    stoppedNames: [],
  });

  const reg = await loadRegistryModule();
  seedRegistry(home, [
    makeRecord({ id: 'left-1', workspace: '/repo-a', hcomName: 'waka' }),
    makeRecord({ id: 'right-1', workspace: '/repo-b', hcomName: 'waka' }),
  ]);

  const { records } = await reg.reconcileGlobalRecords();

  assert.equal(byId(records)['left-1'].state, 'managed_active');
  assert.equal(byId(records)['right-1'].state, 'managed_active');
});

test('an uncontested record matches by name regardless of directory drift', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'hcom-global-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  t.mock.module('node:os', { namedExports: { homedir: () => home } });
  // Service-home pattern: the record's workspace is a broad parent of the
  // agent's real directory. Single-record names are never filtered.
  mockHcom(t, {
    liveAgents: [liveAgent({ directory: '/home/sam/Projects/actual-repo' })],
    stoppedNames: [],
  });

  const reg = await loadRegistryModule();
  seedRegistry(home, [
    makeRecord({ id: 'svc-home-1', workspace: '/home/sam', hcomName: 'waka' }),
  ]);

  const { records } = await reg.reconcileGlobalRecords();

  assert.equal(byId(records)['svc-home-1'].state, 'managed_active');
});
