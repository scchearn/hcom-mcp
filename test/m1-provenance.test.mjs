import test from 'node:test';
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as realFs from 'node:fs';

// One temp home for the whole file (see m1-supervision-install note:
// dist/registry.js resolves REGISTRY_PATH once per process).
const HOME = mkdtempSync(join(tmpdir(), 'hcom-prov-'));
after(() => rmSync(HOME, { recursive: true, force: true }));

let importCounter = 0;

function seedRegistry(records) {
  realFs.mkdirSync(join(HOME, '.hcom', 'mcp'), { recursive: true });
  writeFileSync(join(HOME, '.hcom', 'mcp', 'registry.json'), JSON.stringify({ records }), 'utf-8');
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

// --- resolveRootLauncher ---

test('resolveRootLauncher follows resume chains by record id and fork chains by unique name', async () => {
  const { resolveRootLauncher } = await import(`../dist/registry.js?prov-${++importCounter}`);

  // Resume chain: child -> parent(id) -> grandparent(launchedBy nora).
  const grandparent = makeRecord({ id: 'gp', hcomName: 'waka', launchedBy: 'nora' });
  const parent = makeRecord({ id: 'p', hcomName: 'waka2', resumedFrom: 'gp', launchedBy: 'mid' });
  const child = makeRecord({ id: 'c', hcomName: 'waka3', resumedFrom: 'p', launchedBy: 'mid' });
  assert.equal(resolveRootLauncher(child, [grandparent, parent, child]), 'nora');

  // Fork chain: source referenced by NAME, unique candidate.
  const origin = makeRecord({ id: 'o', hcomName: 'orig', launchedBy: 'nora' });
  const fork = makeRecord({ id: 'f', hcomName: 'fork1', resumedFrom: 'orig', launchedBy: 'kato' });
  assert.equal(resolveRootLauncher(fork, [origin, fork]), 'nora');
});

test('resolveRootLauncher is conservative on ambiguity and cycles', async () => {
  const { resolveRootLauncher } = await import(`../dist/registry.js?prov-${++importCounter}`);

  // Ambiguous fork source (two namesakes): stop walking, fall back to the
  // record's own launcher rather than guessing.
  const a = makeRecord({ id: 'a', hcomName: 'dup', launchedBy: 'nora' });
  const b = makeRecord({ id: 'b', workspace: '/other', hcomName: 'dup', launchedBy: 'kato' });
  const fork = makeRecord({ id: 'f', hcomName: 'fork1', resumedFrom: 'dup', launchedBy: 'kato' });
  assert.equal(resolveRootLauncher(fork, [a, b, fork]), 'kato');

  // Cycle: broken by the visited set, returns something sane.
  const x = makeRecord({ id: 'x', hcomName: 'xeno', resumedFrom: 'y', launchedBy: 'nora' });
  const y = makeRecord({ id: 'y', hcomName: 'yeti', resumedFrom: 'x', launchedBy: 'kato' });
  assert.ok(['nora', 'kato'].includes(resolveRootLauncher(x, [x, y])));

  // No provenance at all.
  const solo = makeRecord({ id: 's', hcomName: 'solo' });
  assert.equal(resolveRootLauncher(solo, [solo]), undefined);
});

// --- watch_agents poll provenance fields ---

function mockWatchDeps(t, { execHcom }) {
  t.mock.module('../dist/hcom.js', {
    namedExports: {
      listHcomAgents: async () => [
        { name: 'mine', base_name: 'mine', status: 'listening', status_age_seconds: 5, unread_count: 0, tag: null },
        { name: 'theirs', base_name: 'theirs', status: 'listening', status_age_seconds: 5, unread_count: 0, tag: null },
      ],
      findLiveAgentByIdentifier: (id, agents) =>
        agents.find((a) => a.name === id || a.base_name === id) ?? null,
      canonicalizeAgentName: (id, agents) =>
        agents.find((a) => a.name === id || a.base_name === id)?.base_name ?? id,
      // registry.js links against these when watch.js pulls it in.
      listStoppedAgentNames: async () => [],
      parseHcomJson: JSON.parse,
      resolveCallerName: async (override) => override,
      execHcom,
    },
  });
}

test('watch_agents poll surfaces launchedBy/rootLaunchedBy and flags foreign launchers', async (t) => {
  t.mock.module('node:os', { namedExports: { homedir: () => HOME } });
  seedRegistry([
    makeRecord({ id: 'r-mine', hcomName: 'mine', launchedBy: 'nora' }),
    // Launched by another hub; its resume chain roots back to nora, but the
    // immediate launcher is what makes it foreign.
    makeRecord({ id: 'r-theirs', hcomName: 'theirs', launchedBy: 'kato', resumedFrom: 'r-root-nora' }),
    makeRecord({ id: 'r-root-nora', hcomName: 'root', launchedBy: 'nora' }),
  ]);
  mockWatchDeps(t, {
    execHcom: async (args) => {
      if (args[0] === 'events') return { exitCode: 0, stdout: '', stderr: '' };
      throw new Error(`unexpected args: ${args.join(' ')}`);
    },
  });

  const { registerWatchAgentsTool } = await import(`../dist/tools/watch.js?prov-${++importCounter}`);
  const server = {
    handlers: new Map(),
    tool(name, _d, _s, handler) { server.handlers.set(name, handler); },
  };
  registerWatchAgentsTool(server);

  const response = await server.handlers.get('watch_agents')({
    workspace: '/repo',
    sender_name: 'nora',
  });
  assert.equal(response.isError, undefined);
  const payload = JSON.parse(response.content[0].text);
  const byName = Object.fromEntries(payload.agents.map((a) => [a.name, a]));

  assert.equal(byName.mine.launchedBy, 'nora');
  assert.equal(byName.mine.foreign, false);
  assert.equal(byName.theirs.launchedBy, 'kato');
  assert.equal(byName.theirs.rootLaunchedBy, 'nora');
  assert.equal(byName.theirs.foreign, true);
});

// --- list_managed / status enrichment ---

test('enrichManagedRecord adds rootLaunchedBy and foreign when a caller is given', async () => {
  const { enrichManagedRecord } = await import(`../dist/tools/list.js?prov-${++importCounter}`);
  const records = [
    makeRecord({ id: 'root', hcomName: 'root', launchedBy: 'nora' }),
    makeRecord({ id: 'child', hcomName: 'waka', launchedBy: 'kato', resumedFrom: 'root' }),
  ];
  const enriched = enrichManagedRecord(records[1], [], { caller: 'nora', records });
  assert.equal(enriched.rootLaunchedBy, 'nora');
  assert.equal(enriched.foreign, true);
  assert.equal(enriched.launchedBy, 'kato');

  // Without a records universe the chain cannot be walked: fall back to the
  // record's own launcher rather than guessing.
  const plain = enrichManagedRecord(records[1], []);
  assert.equal(plain.foreign, false);
  assert.equal(plain.rootLaunchedBy, 'kato');
});

test('status reports a byLauncher breakdown over reconciled workspace records', async (t) => {
  t.mock.module('../dist/hcom.js', {
    namedExports: {
      listHcomAgents: async () => [],
      listStoppedAgentNames: async () => [],
      parseHcomJson: JSON.parse,
      resolveCallerName: async () => undefined,
      execHcom: async (args) => {
        if (args[0] === '--version') return { exitCode: 0, stdout: 'hcom 0.7.25', stderr: '' };
        if (args[0] === 'status') return { exitCode: 0, stdout: '{}', stderr: '' };
        throw new Error(`unexpected args: ${args.join(' ')}`);
      },
    },
  });
  t.mock.module('../dist/registry.js', {
    namedExports: {
      getRecordsByWorkspace: () => [],
      getOwnedRecordsByWorkspace: () => [],
      reconcileGlobalRecords: async () => ({
        records: [
          { id: 'a', workspace: '/repo', state: 'managed_active', launchedBy: 'nora' },
          { id: 'b', workspace: '/repo', state: 'managed_active', launchedBy: 'nora' },
          { id: 'c', workspace: '/repo', state: 'adopted_lost' },
        ],
        transitions: [],
        liveAgents: [],
        stoppedNames: [],
      }),
      matchLiveAgent: () => null,
      persistReconciledState: () => {},
      reconcileManagedRecords: (records) => records,
      resolveRootLauncher: (record) => record.launchedBy,
    },
  });
  t.mock.module('../dist/config.js', {
    namedExports: {
      loadMergedConfig: () => ({ agentPresets: {}, topologyPresets: {}, supervision: {} }),
      getConfigPaths: () => ({}),
      summarizeAgentPresets: () => [],
      summarizeTopologyPresets: () => [],
    },
  });

  const { registerStatusTool } = await import(`../dist/tools/list.js?prov-${++importCounter}`);
  const server = {
    handlers: new Map(),
    tool(name, _d, _s, handler) { server.handlers.set(name, handler); },
  };
  registerStatusTool(server);

  const response = await server.handlers.get('status')({ workspace: '/repo' });
  const payload = JSON.parse(response.content[0].text);
  assert.deepEqual(payload.byLauncher, { nora: 2, '(unattributed)': 1 });
});
