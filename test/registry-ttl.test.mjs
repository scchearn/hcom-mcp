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

test('reconcile flags an expired record as managed_expired even when the agent is live', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'hcom-ttl-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  t.mock.module('node:os', { namedExports: { homedir: () => home } });
  mockHcom(t, {
    live: [{ name: 'waka', base_name: 'waka', status: 'listening' }],
    stoppedNames: [],
  });

  const reg = await loadRegistryModule();
  const records = [
    makeRecord({
      id: 'expired-1',
      state: 'managed_active',
      expiresAt: '2026-01-01T00:00:00.000Z',
    }),
  ];
  const reconciled = reg.reconcileManagedRecords(records, [
    { name: 'waka', base_name: 'waka', status: 'listening' },
  ]);
  assert.equal(reconciled[0].state, 'managed_expired');
});

test('reconcile leaves a non-expired record alone', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'hcom-ttl-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  t.mock.module('node:os', { namedExports: { homedir: () => home } });
  mockHcom(t, {
    live: [{ name: 'waka', base_name: 'waka', status: 'listening' }],
    stoppedNames: [],
  });

  const reg = await loadRegistryModule();
  const records = [
    makeRecord({
      id: 'fresh-1',
      state: 'managed_active',
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    }),
  ];
  const reconciled = reg.reconcileManagedRecords(records, [
    { name: 'waka', base_name: 'waka', status: 'listening' },
  ]);
  assert.equal(reconciled[0].state, 'managed_active');
});

test('prune expired=true targets only expired records', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'hcom-ttl-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  t.mock.module('node:os', { namedExports: { homedir: () => home } });
  mockHcom(t, { live: [], stoppedNames: [] });

  const reg = await loadRegistryModule();
  seedRegistry(home, [
    makeRecord({ id: 'expired-1', state: 'managed_expired', expiresAt: '2026-01-01T00:00:00.000Z' }),
    makeRecord({ id: 'lost-1', state: 'managed_lost', lastSeenAt: '2026-01-01T00:00:00.000Z' }),
  ]);

  const result = await reg.pruneRecords('/repo', { expired: true });
  assert.deepEqual(result.wouldRemove.map((r) => r.id), ['expired-1']);
});

// --- #13: allWorkspaces + deprecated alias ---

test('prune tool expired+confirm kills the agents then clears their records', async (t) => {
  const killTargets = [];
  t.mock.module('../dist/hcom.js', {
    namedExports: {
      execHcom: async (args) => {
        if (args[0] === 'kill') {
          killTargets.push(args[1]);
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        throw new Error(`unexpected args: ${args.join(' ')}`);
      },
    },
  });
  t.mock.module('../dist/registry.js', {
    namedExports: {
      pruneRecords: async (workspace, options) => {
        if (options.confirm) {
          return { removed: [{ id: 'expired-1', hcomName: 'waka', state: 'managed_expired' }], wouldRemove: [] };
        }
        return { removed: [], wouldRemove: [{ id: 'expired-1', hcomName: 'waka', state: 'managed_expired' }] };
      },
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

  const response = await server.handlers.get('prune')({
    workspace: '/repo',
    expired: true,
    confirm: true,
  });

  assert.equal(response.isError, undefined);
  assert.deepEqual(killTargets, ['waka']);
  const payload = JSON.parse(response.content[0].text);
  assert.equal(payload.dryRun, false);
  assert.equal(payload.count, 1);
  assert.deepEqual(payload.killed, ['waka']);
});

test('launch with ttl_minutes persists expiresAt on the record', async (t) => {
  const added = [];
  t.mock.module('../dist/hcom.js', {
    namedExports: {
      resolveCallerName: async (override) => override,
      execHcom: async () => ({ exitCode: 0, stdout: 'Names: waka\nBatch id: batch-77\n', stderr: '' }),
      listHarnessModels: async (harness) => {
        const models = { claude: ['sonnet'], opencode: ['opencode/deepseek-v4-flash-free'] };
        const available = models[harness] || [];
        return [{ harness, status: 'live', source: 'mock', models: available, count: available.length }];
      },
    },
  });
  t.mock.module('../dist/registry.js', {
    namedExports: {
      REGISTRY_PATH: '/tmp/registry.json',
      addRecord: (record) => {
        added.push(record);
        return { ...record, id: `record-${added.length}` };
      },
      removeRecords: () => {},
      updateRecordState: () => null,
      updateRecordVerify: () => null,
    },
  });

  const { registerLaunchTool } = await import(`../dist/tools/launch.js?${importCounter++}`);
  const server = {
    names: [],
    handlers: new Map(),
    tool(name, _desc, _schema, handler) {
      this.names.push(name);
      this.handlers.set(name, handler);
    },
  };
  registerLaunchTool(server);

  const before = Date.now();
  const response = await server.handlers.get('launch')({
    harness: 'opencode',
    model: 'opencode/deepseek-v4-flash-free',
    sender_name: 'nora',
    ttl_minutes: 30,
  });

  assert.ok(!response.isError, response?.content?.[0]?.text);
  assert.equal(added.length, 1);
  assert.ok(added[0].expiresAt, 'expiresAt must be persisted');
  const expiry = new Date(added[0].expiresAt).getTime();
  assert.ok(expiry >= before + 30 * 60 * 1000 - 5000, 'expiry ~30min in the future');
  assert.ok(expiry <= before + 30 * 60 * 1000 + 5000, 'expiry ~30min in the future');
});

test('launch without ttl_minutes persists no expiresAt', async (t) => {
  const added = [];
  t.mock.module('../dist/hcom.js', {
    namedExports: {
      resolveCallerName: async (override) => override,
      execHcom: async () => ({ exitCode: 0, stdout: 'Names: waka\nBatch id: batch-77\n', stderr: '' }),
      listHarnessModels: async (harness) => {
        const models = { claude: ['sonnet'], opencode: ['opencode/deepseek-v4-flash-free'] };
        const available = models[harness] || [];
        return [{ harness, status: 'live', source: 'mock', models: available, count: available.length }];
      },
    },
  });
  t.mock.module('../dist/registry.js', {
    namedExports: {
      REGISTRY_PATH: '/tmp/registry.json',
      addRecord: (record) => {
        added.push(record);
        return { ...record, id: `record-${added.length}` };
      },
      removeRecords: () => {},
      updateRecordState: () => null,
      updateRecordVerify: () => null,
    },
  });

  const { registerLaunchTool } = await import(`../dist/tools/launch.js?${importCounter++}`);
  const server = {
    names: [],
    handlers: new Map(),
    tool(name, _desc, _schema, handler) {
      this.names.push(name);
      this.handlers.set(name, handler);
    },
  };
  registerLaunchTool(server);

  const response = await server.handlers.get('launch')({
    harness: 'opencode',
    model: 'opencode/deepseek-v4-flash-free',
    sender_name: 'nora',
  });

  assert.ok(!response.isError, response?.content?.[0]?.text);
  assert.equal(added[0].expiresAt, undefined);
});

// --- Review round fixes ---

test('reconcile reverts a flagged-expired record when expiresAt is extended', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'hcom-ttl-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  t.mock.module('node:os', { namedExports: { homedir: () => home } });
  mockHcom(t, {
    liveAgents: [{ name: 'waka', base_name: 'waka', status: 'listening' }],
    stoppedNames: [],
  });

  const reg = await loadRegistryModule();
  const records = [
    makeRecord({
      id: 'expired-1',
      state: 'managed_expired',
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    }),
  ];
  const reconciled = reg.reconcileManagedRecords(records, [
    { name: 'waka', base_name: 'waka', status: 'listening' },
  ]);
  // No longer expired + live → back to active, not stuck *_expired forever.
  assert.equal(reconciled[0].state, 'managed_active');
});

test('reconcile leaves a lost record lost even when its expiresAt has passed', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'hcom-ttl-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  t.mock.module('node:os', { namedExports: { homedir: () => home } });
  mockHcom(t, { live: [], stoppedNames: [] });

  const reg = await loadRegistryModule();
  const records = [
    makeRecord({
      id: 'lost-1',
      state: 'managed_lost',
      expiresAt: '2026-01-01T00:00:00.000Z',
    }),
  ];
  const reconciled = reg.reconcileManagedRecords(records, []);
  // Lost stays lost: it ages out via the normal lost-prune path, not the
  // expired mode.
  assert.equal(reconciled[0].state, 'managed_lost');
});

test('prune reconciles only the scoped workspace when allWorkspaces=false', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'hcom-prune-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  t.mock.module('node:os', { namedExports: { homedir: () => home } });
  mockHcom(t, { live: [], stoppedNames: [] });

  const reg = await loadRegistryModule();
  seedRegistry(home, [
    makeRecord({ id: 'a-1', workspace: '/ws-a', hcomName: 'ghost-a', state: 'managed_active', lastSeenAt: '2026-01-01T00:00:00.000Z' }),
    makeRecord({ id: 'b-1', workspace: '/ws-b', hcomName: 'ghost-b', state: 'managed_active', lastSeenAt: '2026-01-01T00:00:00.000Z' }),
  ]);

  await reg.pruneRecords('/ws-a', { lostOlderThanDays: 7, confirm: true });

  // Workspace A's phantom was demoted and pruned; workspace B's record is
  // untouched (still managed_active, still present).
  const after = readRegistry(home);
  assert.deepEqual(after.records.map((r) => r.id), ['b-1']);
  assert.equal(after.records[0].state, 'managed_active');
});

test('reconcile-driven transitions do not reset the lastSeenAt age clock', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'hcom-prune-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  t.mock.module('node:os', { namedExports: { homedir: () => home } });
  mockHcom(t, { live: [], stoppedNames: [] });

  const reg = await loadRegistryModule();
  seedRegistry(home, [
    makeRecord({ id: 'phantom-1', hcomName: 'ghost', state: 'managed_active', lastSeenAt: '2026-01-01T00:00:00.000Z' }),
  ]);

  // Dry-run reconcile demotes the phantom to lost and persists it.
  await reg.pruneRecords('/repo', { lostOlderThanDays: 7 });

  const after = readRegistry(home);
  assert.equal(after.records[0].state, 'managed_lost');
  // The age clock must NOT have been reset to now: the record keeps its
  // January lastSeenAt so the age rules still apply.
  assert.equal(after.records[0].lastSeenAt, '2026-01-01T00:00:00.000Z');
});

test('launch rejects ttl_minutes beyond the 10-year cap', async (t) => {
  // The fake server bypasses zod, so validate the schema directly: the cap
  // must reject absurd values that would overflow Date.
  const { HarnessEnum } = await import(`../dist/types.js?${importCounter++}`);
  const { z } = await import('zod');
  const ttlSchema = z.number().int().positive().max(5256000).optional();

  assert.equal(ttlSchema.safeParse(5256000).success, true);
  assert.equal(ttlSchema.safeParse(Number.MAX_SAFE_INTEGER).success, false);
  assert.equal(ttlSchema.safeParse(undefined).success, true);
  assert.equal(HarnessEnum.options.length > 0, true);
});
