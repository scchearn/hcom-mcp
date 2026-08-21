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

// --- Phase 0: global reconcile across all workspaces ---

test('reconcileGlobalRecords demotes phantom active records in dead worktree workspaces', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'hcom-global-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  t.mock.module('node:os', { namedExports: { homedir: () => home } });
  // Only waka is live: vade's worktree is long gone.
  mockHcom(t, {
    liveAgents: [{ name: 'waka', base_name: 'waka', status: 'listening' }],
    stoppedNames: [],
  });

  const reg = await loadRegistryModule();
  seedRegistry(home, [
    makeRecord({ id: 'w2-1', workspace: '/repo-w2', hcomName: 'vade', state: 'managed_active' }),
    makeRecord({ id: 'w5-1', workspace: '/repo-w5', hcomName: 'nute', state: 'managed_active' }),
    makeRecord({ id: 'live-1', workspace: '/repo', hcomName: 'waka', state: 'managed_active' }),
  ]);

  const { records, transitions } = await reg.reconcileGlobalRecords();

  const byId = Object.fromEntries(records.map((r) => [r.id, r]));
  // Records no tool call would ever target are healed by the global pass.
  assert.equal(byId['w2-1'].state, 'managed_lost');
  assert.equal(byId['w5-1'].state, 'managed_lost');
  assert.equal(byId['live-1'].state, 'managed_active');
  assert.equal(transitions, 2);

  const persisted = Object.fromEntries(readRegistry(home).records.map((r) => [r.id, r]));
  assert.equal(persisted['w2-1'].state, 'managed_lost');
  assert.equal(persisted['live-1'].state, 'managed_active');
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
  assert.equal(transitions, 1);

  const persisted = Object.fromEntries(readRegistry(home).records.map((r) => [r.id, r]));
  assert.equal(persisted['released-1'].state, 'managed_released');
  // Released records are not reconciled or rewritten.
  assert.equal(persisted['released-1'].lastSeenAt, '2026-05-01T00:00:00.000Z');
  // Reconcile transitions are bookkeeping: lastSeenAt (the prune age clock)
  // must not move, or every demotion would reset prune's reach.
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

  const byId = Object.fromEntries(records.map((r) => [r.id, r]));
  assert.equal(byId['stopped-w3'].state, 'managed_stopped');
  assert.equal(byId['vanished-w4'].state, 'managed_lost');
});
