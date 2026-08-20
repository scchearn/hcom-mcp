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

test('prune expired+confirm aborts when a kill fails, leaving records intact', async (t) => {
  const killTargets = [];
  let confirmCalled = false;
  t.mock.module('../dist/hcom.js', {
    namedExports: {
      canonicalizeAgentName: (name) => name,
      execHcom: async (args) => {
        if (args[0] === 'kill') {
          killTargets.push(args[1]);
          // First kill fails (agent still alive), second succeeds.
          return killTargets.length === 1
            ? { exitCode: 1, stdout: '', stderr: 'kill failed' }
            : { exitCode: 0, stdout: '', stderr: '' };
        }
        throw new Error(`unexpected args: ${args.join(' ')}`);
      },
      findLiveAgentByIdentifier: () => null,
      listHcomAgents: async () => [],
      resolveCallerName: async (override) => override,
    },
  });
  t.mock.module('../dist/registry.js', {
    namedExports: {
      pruneRecords: async (workspace, options) => {
        if (options.confirm) {
          confirmCalled = true;
          return { removed: [], wouldRemove: [] };
        }
        return {
          removed: [],
          wouldRemove: [
            { id: 'expired-1', hcomName: 'waka', state: 'managed_expired' },
            { id: 'expired-2', hcomName: 'zama', state: 'managed_expired' },
          ],
        };
      },
      getOwnedRecordsByWorkspace: () => [],
      removeRecords: () => null,
      updateRecordState: () => null,
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

  // The failed kill must abort the whole clear: no orphaned live agents.
  assert.equal(response.isError, true);
  assert.match(response.content[0].text, /failed to kill waka/);
  assert.equal(confirmCalled, false);
  // Both kills were attempted; the clear was aborted because one failed.
  assert.deepEqual(killTargets, ['waka', 'zama']);
});

test('prune expired refuses a report-promising record with structured gate evidence', async (t) => {
  let teardownOptions;
  let removedIds;
  t.mock.module('../dist/hcom.js', {
    namedExports: {
      execHcom: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      listHcomAgents: async () => [{ name: 'waka', base_name: 'waka', status: 'listening' }],
    },
  });
  t.mock.module('../dist/tools/lifecycle.js', {
    namedExports: {
      runTeardown: async (_targets, _action, options) => {
        teardownOptions = options;
        return [{ name: 'waka', ok: false, text: '[E_REPORT_REQUIRED] report missing' }];
      },
    },
  });
  t.mock.module('../dist/registry.js', {
    namedExports: {
      pruneRecords: async (_workspace, options) => options.confirm
        ? { removed: [], wouldRemove: [] }
        : { removed: [], wouldRemove: [{ id: 'expired-1', hcomName: 'waka', state: 'managed_expired' }] },
      removeRecords: (ids) => { removedIds = ids; },
    },
  });

  const { registerPruneTool } = await import(`../dist/tools/prune.js?${importCounter++}`);
  const server = {
    handlers: new Map(),
    tool(name, _desc, _schema, handler) {
      this.handlers.set(name, handler);
    },
  };
  registerPruneTool(server);

  const response = await server.handlers.get('prune')({
    workspace: '/repo',
    expired: true,
    confirm: true,
  });

  assert.equal(response.isError, true);
  const payload = JSON.parse(response.content[0].text);
  assert.deepEqual(payload.skipped, ['[E_REPORT_REQUIRED] report missing']);
  assert.equal(payload.teardown[0].ok, false);
  assert.equal(teardownOptions.force, false);
  assert.equal(removedIds, undefined);
});

test('prune expired force path kills and clears report-promising records intentionally', async (t) => {
  let teardownOptions;
  let removedIds;
  t.mock.module('../dist/hcom.js', {
    namedExports: {
      execHcom: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      listHcomAgents: async () => [{ name: 'waka', base_name: 'waka', status: 'listening' }],
    },
  });
  t.mock.module('../dist/tools/lifecycle.js', {
    namedExports: {
      runTeardown: async (_targets, _action, options) => {
        teardownOptions = options;
        return [{ name: 'waka', ok: true, text: 'Killed agent "waka".' }];
      },
    },
  });
  t.mock.module('../dist/registry.js', {
    namedExports: {
      pruneRecords: async () => ({ removed: [], wouldRemove: [{ id: 'expired-1', hcomName: 'waka', state: 'managed_expired' }] }),
      removeRecords: (ids) => { removedIds = ids; },
    },
  });

  const { registerPruneTool } = await import(`../dist/tools/prune.js?${importCounter++}`);
  const server = {
    handlers: new Map(),
    tool(name, _desc, _schema, handler) {
      this.handlers.set(name, handler);
    },
  };
  registerPruneTool(server);

  const response = await server.handlers.get('prune')({
    workspace: '/repo',
    expired: true,
    confirm: true,
    force: true,
  });

  assert.equal(response.isError, undefined);
  const payload = JSON.parse(response.content[0].text);
  assert.deepEqual(payload.killed, ['waka']);
  assert.deepEqual(removedIds, ['expired-1']);
  assert.equal(teardownOptions.force, true);
});

test('prune tool resolves the deprecated olderThanDays alias at the tool surface', async (t) => {
  const received = [];
  t.mock.module('../dist/hcom.js', {
    namedExports: {
      canonicalizeAgentName: (name) => name,
      execHcom: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      findLiveAgentByIdentifier: () => null,
      listHcomAgents: async () => [],
      resolveCallerName: async (override) => override,
    },
  });
  t.mock.module('../dist/registry.js', {
    namedExports: {
      pruneRecords: async (workspace, options) => {
        received.push(options);
        return { removed: [], wouldRemove: [] };
      },
      getOwnedRecordsByWorkspace: () => [],
      removeRecords: () => null,
      updateRecordState: () => null,
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

  // Legacy caller passes the deprecated name: the tool must forward 14, not
  // the zod default 7.
  await server.handlers.get('prune')({ workspace: '/repo', olderThanDays: 14 });
  assert.equal(received[0].lostOlderThanDays, 14);

  // New name wins when both are present.
  await server.handlers.get('prune')({ workspace: '/repo', olderThanDays: 14, lostOlderThanDays: 21 });
  assert.equal(received[1].lostOlderThanDays, 21);
});

test('legacy string-harness presets pass ttlMinutes through normalization', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'hcom-cfg-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  t.mock.module('node:os', { namedExports: { homedir: () => home } });
  t.mock.module('../dist/registry.js', {
    namedExports: { REGISTRY_PATH: '/tmp/registry.json' },
  });

  const configPath = join(home, '.hcom', 'mcp', 'config.json');
  realFs.mkdirSync(join(home, '.hcom', 'mcp'), { recursive: true });
  writeFileSync(
    configPath,
    JSON.stringify({
      agentPresets: {
        ephemeral: {
          name: 'ephemeral',
          harness: 'claude',
          model: 'haiku',
          ttlMinutes: 30,
        },
      },
    }),
    'utf-8',
  );

  const { loadGlobalConfig } = await import(`../dist/config.js?${importCounter++}`);
  const config = loadGlobalConfig('/repo');
  assert.equal(config.agentPresets.ephemeral.ttlMinutes, 30);
});
