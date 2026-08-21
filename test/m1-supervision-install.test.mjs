import test from 'node:test';
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as realFs from 'node:fs';

// One temp home for the whole file: dist/registry.js resolves REGISTRY_PATH
// at module load, so every launch.js?N instance created below shares the
// first registry instance. Tests seed distinct record sets by rewriting the
// same registry file.
const HOME = mkdtempSync(join(tmpdir(), 'hcom-m1-'));
after(() => rmSync(HOME, { recursive: true, force: true }));

let importCounter = 0;

async function loadLaunchModule() {
  importCounter += 1;
  return import(`../dist/tools/launch.js?m1-${importCounter}`);
}

function createFakeServer() {
  const handlers = new Map();
  return {
    handlers,
    tool(name, _description, _schema, handler) {
      handlers.set(name, handler);
    },
  };
}

const REGISTRY_PATH = () => join(HOME, '.hcom', 'mcp', 'registry.json');

function seedRegistry(records = []) {
  realFs.mkdirSync(join(HOME, '.hcom', 'mcp'), { recursive: true });
  writeFileSync(REGISTRY_PATH(), JSON.stringify({ records }), 'utf-8');
}

function readRegistry() {
  if (!existsSync(REGISTRY_PATH())) return { records: [] };
  return JSON.parse(readFileSync(REGISTRY_PATH(), 'utf-8'));
}

function mockHcom(t, { execHcom, models = { claude: ['sonnet'], opencode: ['opencode/deepseek-v4-flash-free'] } }) {
  t.mock.module('../dist/hcom.js', {
    namedExports: {
      resolveCallerName: async (override) => override,
      execHcom,
      // registry.js links against these at import time even though launch
      // paths never call them.
      findLiveAgentByIdentifier: (id, agents) =>
        agents.find((a) => a.name === id || a.base_name === id) ?? null,
      listHcomAgents: async () => [],
      listStoppedAgentNames: async () => [],
      listHarnessModels: async (harness) => {
        const available = models[harness] || [];
        return [{ harness, status: 'live', source: 'mock', models: available, count: available.length }];
      },
    },
  });
}

function mockConfig(t, { globalSupervision, presets = {} }) {
  t.mock.module('../dist/config.js', {
    namedExports: {
      loadMergedConfig: () => ({
        agentPresets: presets,
        topologyPresets: {},
        rescueAllowlist: { enabled: true, patterns: [] },
        supervision: globalSupervision ?? {},
      }),
      resolveAgentPreset: (cfg, name) => cfg.agentPresets[name] || null,
      resolveTopologyPreset: (cfg, name) => cfg.topologyPresets[name] || null,
      validateTopologyReferences: () => [],
    },
  });
}

const LAUNCH_OK = 'Names: waka\nBatch id: batch-1\n';
const SUB_OK = 'Subscription sub-abc123 created';

test('launch auto-installs life+blocked subscriptions for the hub and persists them on the record', async (t) => {
  t.mock.module('node:os', { namedExports: { homedir: () => HOME } });
  const calls = [];
  mockHcom(t, {
    execHcom: async (args) => {
      calls.push(args);
      if (args[0] === 'events' && args[1] === 'sub') {
        return { exitCode: 0, stdout: `Subscription ${args.includes('--type') ? 'sub-1dea11' : 'sub-b10b22'} created`, stderr: '' };
      }
      return { exitCode: 0, stdout: LAUNCH_OK, stderr: '' };
    },
  });
  mockConfig(t, {});
  seedRegistry([]);

  const { registerLaunchTool } = await loadLaunchModule();
  const server = createFakeServer();
  registerLaunchTool(server);

  const response = await server.handlers.get('launch')({
    harness: 'claude',
    model: 'sonnet',
    sender_name: 'nora',
  });
  assert.equal(response.isError, undefined);

  // Both push-lane kinds installed on behalf of the launching hub.
  const subCalls = calls.filter((a) => a[0] === 'events' && a[1] === 'sub');
  assert.equal(subCalls.length, 2);
  assert.ok(subCalls.every((a) => a.includes('--for') && a.includes('nora')));
  assert.ok(subCalls.some((a) => a.includes('--type') && a.includes('life')));
  assert.ok(subCalls.some((a) => a.includes('--status') && a.includes('blocked')));

  // Result payload surfaces what was installed.
  const payload = JSON.parse(response.content[0].text);
  assert.equal(payload.supervision.policy.attentionAfterSec, 180);
  assert.equal(payload.supervision.policy.escalateAfterSec, 360);
  assert.deepEqual(
    payload.supervision.agents[0].subscriptions.map((s) => s.kind).sort(),
    ['blocked', 'life'],
  );

  // The registry record carries the persisted state, including sub ids.
  const [record] = readRegistry().records;
  assert.equal(record.hcomName, 'waka');
  assert.equal(record.supervision.hub, 'nora');
  assert.equal(record.supervision.policy.enabled, true);
  assert.equal(record.supervision.policy.attentionAfterSec, 180);
  assert.deepEqual(record.supervision.subscriptions.sort((a, b) => a.kind.localeCompare(b.kind)), [
    { kind: 'blocked', subId: 'sub-b10b22' },
    { kind: 'life', subId: 'sub-1dea11' },
  ]);
  assert.match(record.supervision.baselineAt, /^2026-/);
  assert.equal(record.supervision.baselineAt, record.dispatchAt);
});

test('supervise:false opts out entirely: no subscription calls, no supervision state', async (t) => {
  t.mock.module('node:os', { namedExports: { homedir: () => HOME } });
  const calls = [];
  mockHcom(t, {
    execHcom: async (args) => {
      calls.push(args);
      return { exitCode: 0, stdout: LAUNCH_OK, stderr: '' };
    },
  });
  mockConfig(t, {});
  seedRegistry([]);

  const { registerLaunchTool } = await loadLaunchModule();
  const server = createFakeServer();
  registerLaunchTool(server);

  const response = await server.handlers.get('launch')({
    harness: 'claude',
    model: 'sonnet',
    sender_name: 'nora',
    supervise: false,
  });
  assert.equal(response.isError, undefined);

  assert.equal(calls.filter((a) => a[0] === 'events' && a[1] === 'sub').length, 0);
  const payload = JSON.parse(response.content[0].text);
  assert.equal(payload.supervision, undefined);
  const [record] = readRegistry().records;
  assert.equal(record.supervision, undefined);
});

test('headed launches are not supervised', async (t) => {
  t.mock.module('node:os', { namedExports: { homedir: () => HOME } });
  const calls = [];
  mockHcom(t, {
    execHcom: async (args) => {
      calls.push(args);
      return { exitCode: 0, stdout: LAUNCH_OK, stderr: '' };
    },
  });
  mockConfig(t, {
    presets: {
      headed: {
        name: 'headed',
        headless: false,
        pty: false,
        harness: { claude: { model: 'sonnet' } },
      },
    },
  });
  seedRegistry([]);

  const { registerLaunchTool } = await loadLaunchModule();
  const server = createFakeServer();
  registerLaunchTool(server);

  const response = await server.handlers.get('launch')({
    preset: 'headed',
    harness: 'claude',
    sender_name: 'nora',
  });
  assert.equal(response.isError, undefined);
  assert.equal(calls.filter((a) => a[0] === 'events' && a[1] === 'sub').length, 0);
  const [record] = readRegistry().records;
  assert.equal(record.launchMode, 'headed');
  assert.equal(record.supervision, undefined);
});

test('a failed launch (exit 1) gets no subscriptions — the corpses were killed', async (t) => {
  t.mock.module('node:os', { namedExports: { homedir: () => HOME } });
  const calls = [];
  mockHcom(t, {
    execHcom: async (args) => {
      calls.push(args);
      if (args[0] === 'kill') return { exitCode: 0, stdout: '', stderr: '' };
      return { exitCode: 1, stdout: LAUNCH_OK, stderr: 'spawn failed' };
    },
  });
  mockConfig(t, {});
  seedRegistry([]);

  const { registerLaunchTool } = await loadLaunchModule();
  const server = createFakeServer();
  registerLaunchTool(server);

  const response = await server.handlers.get('launch')({
    harness: 'claude',
    model: 'sonnet',
    sender_name: 'nora',
  });
  assert.equal(response.isError, true);
  assert.equal(calls.filter((a) => a[0] === 'events' && a[1] === 'sub').length, 0);
});

test('a blocked launch (exit 2) is still supervised — the agent is alive', async (t) => {
  t.mock.module('node:os', { namedExports: { homedir: () => HOME } });
  const calls = [];
  mockHcom(t, {
    execHcom: async (args) => {
      calls.push(args);
      if (args[0] === 'events' && args[1] === 'sub') {
        return { exitCode: 0, stdout: SUB_OK, stderr: '' };
      }
      return { exitCode: 2, stdout: LAUNCH_OK, stderr: '' };
    },
  });
  mockConfig(t, {});
  seedRegistry([]);

  const { registerLaunchTool } = await loadLaunchModule();
  const server = createFakeServer();
  registerLaunchTool(server);

  const response = await server.handlers.get('launch')({
    harness: 'claude',
    model: 'sonnet',
    sender_name: 'nora',
  });
  assert.equal(response.isError, undefined);
  const payload = JSON.parse(response.content[0].text);
  assert.equal(payload.blocked, true);
  assert.equal(payload.supervision.agents.length, 1);
  const [record] = readRegistry().records;
  assert.equal(record.state, 'managed_blocked');
  assert.equal(record.supervision.subscriptions.length, 2);
});

test('policy precedence: per-launch beats preset beats global over defaults', async (t) => {
  t.mock.module('node:os', { namedExports: { homedir: () => HOME } });
  mockHcom(t, {
    execHcom: async (args) => {
      if (args[0] === 'events' && args[1] === 'sub') {
        return { exitCode: 0, stdout: SUB_OK, stderr: '' };
      }
      return { exitCode: 0, stdout: LAUNCH_OK, stderr: '' };
    },
  });
  mockConfig(t, {
    globalSupervision: { attentionAfterSec: 60, escalateAfterSec: 120 },
    presets: {
      worker: {
        name: 'worker',
        headless: true,
        pty: false,
        harness: { claude: { model: 'sonnet' } },
        supervision: { attentionAfterSec: 90 },
      },
    },
  });
  seedRegistry([]);

  const { registerLaunchTool } = await loadLaunchModule();
  const server = createFakeServer();
  registerLaunchTool(server);

  // Launch param overrides attention only; escalate falls through to global.
  const response = await server.handlers.get('launch')({
    preset: 'worker',
    harness: 'claude',
    sender_name: 'nora',
    attention_after_sec: 30,
  });
  assert.equal(response.isError, undefined);
  const [record] = readRegistry().records;
  assert.deepEqual(record.supervision.policy, {
    enabled: true,
    attentionAfterSec: 30,
    escalateAfterSec: 120,
  });

  // Without a launch param, the preset override wins over global.
  seedRegistry([]);
  const response2 = await server.handlers.get('launch')({
    preset: 'worker',
    harness: 'claude',
    sender_name: 'nora',
  });
  assert.equal(response2.isError, undefined);
  const [record2] = readRegistry().records;
  assert.deepEqual(record2.supervision.policy, {
    enabled: true,
    attentionAfterSec: 90,
    escalateAfterSec: 120,
  });
});

test('count>1 batches install subscriptions per agent and persist per record', async (t) => {
  t.mock.module('node:os', { namedExports: { homedir: () => HOME } });
  const subAgents = [];
  mockHcom(t, {
    execHcom: async (args) => {
      if (args[0] === 'events' && args[1] === 'sub') {
        subAgents.push(args[args.indexOf('--agent') + 1]);
        return { exitCode: 0, stdout: `Subscription sub-${subAgents.length}aaaaaa created`, stderr: '' };
      }
      return { exitCode: 0, stdout: 'Names: waka zago\nBatch id: batch-1\n', stderr: '' };
    },
  });
  mockConfig(t, {});
  seedRegistry([]);

  const { registerLaunchTool } = await loadLaunchModule();
  const server = createFakeServer();
  registerLaunchTool(server);

  const response = await server.handlers.get('launch')({
    harness: 'claude',
    model: 'sonnet',
    count: 2,
    sender_name: 'nora',
  });
  assert.equal(response.isError, undefined);
  // Two kinds per agent: life + blocked.
  assert.deepEqual([...new Set(subAgents)].sort(), ['waka', 'zago']);
  assert.equal(subAgents.length, 4);
  const records = readRegistry().records;
  assert.equal(records.length, 2);
  for (const record of records) {
    assert.equal(record.supervision.hub, 'nora');
    assert.equal(record.supervision.subscriptions.length, 2);
  }
});

test('ensureSupervisionSubscriptions is idempotent per kind', async (t) => {
  t.mock.module('node:os', { namedExports: { homedir: () => HOME } });
  const kindsInstalled = [];
  const { ensureSupervisionSubscriptions } = await import(`../dist/supervision.js?m1-${++importCounter}`);
  const result = await ensureSupervisionSubscriptions('nora', 'waka', [{ kind: 'life', subId: 'sub-existing' }], async (args) => {
    kindsInstalled.push(args.includes('--status') ? 'blocked' : 'life');
    return { exitCode: 0, stdout: 'Subscription sub-feed99 created', stderr: '' };
  });
  assert.deepEqual(kindsInstalled, ['blocked']);
  assert.deepEqual(result.subscriptions, [
    { kind: 'life', subId: 'sub-existing' },
    { kind: 'blocked', subId: 'sub-feed99' },
  ]);

  // Fully-installed workers trigger zero calls.
  const result2 = await ensureSupervisionSubscriptions(
    'nora',
    'waka',
    [
      { kind: 'life', subId: 'sub-a' },
      { kind: 'blocked', subId: 'sub-b' },
    ],
    async () => {
      throw new Error('no calls expected when all kinds are installed');
    },
  );
  assert.equal(result2.errors.length, 0);
  assert.equal(result2.subscriptions.length, 2);
});

// --- review hardening (gimu M1 gate) ---

test('policy invariant: escalation at or before the first alert is rejected at every layer', async (t) => {
  t.mock.module('node:os', { namedExports: { homedir: () => HOME } });
  const { resolveSupervisionPolicy } = await import(`../dist/supervision.js?m1-${++importCounter}`);

  // Merged layers that would put escalation before the first alert throw.
  assert.throws(
    () => resolveSupervisionPolicy({ attentionAfterSec: 180 }, { escalateAfterSec: 60 }),
    /escalateAfterSec must exceed attentionAfterSec/,
  );

  // The global config layer parses through the same schema.
  seedRegistry([]);
  realFs.mkdirSync(join(HOME, '.hcom', 'mcp'), { recursive: true });
  writeFileSync(
    join(HOME, '.hcom', 'mcp', 'config.json'),
    JSON.stringify({ supervision: { attentionAfterSec: 300, escalateAfterSec: 120 } }),
    'utf-8',
  );
  t.mock.module('../dist/hcom.js', {
    namedExports: {
      resolveCallerName: async (override) => override,
      execHcom: async () => ({ exitCode: 0, stdout: LAUNCH_OK, stderr: '' }),
      findLiveAgentByIdentifier: () => null,
      listHcomAgents: async () => [],
      listStoppedAgentNames: async () => [],
      listHarnessModels: async () => [{ harness: 'claude', status: 'live', source: 'mock', models: ['sonnet'], count: 1 }],
    },
  });
  const { registerLaunchTool } = await loadLaunchModule();
  const server = createFakeServer();
  registerLaunchTool(server);
  const response = await server.handlers.get('launch')({
    harness: 'claude',
    model: 'sonnet',
    sender_name: 'nora',
  });
  assert.equal(response.isError, true);
  assert.match(response.content[0].text, /escalateAfterSec must exceed attentionAfterSec/);
  rmSync(join(HOME, '.hcom', 'mcp', 'config.json'), { force: true });
});

test('a programmatic launch without sender identity surfaces a supervisionNote instead of skipping silently', async (t) => {
  t.mock.module('node:os', { namedExports: { homedir: () => HOME } });
  const calls = [];
  mockHcom(t, {
    execHcom: async (args) => {
      calls.push(args);
      return { exitCode: 0, stdout: LAUNCH_OK, stderr: '' };
    },
  });
  mockConfig(t, {});
  seedRegistry([]);

  const { launchAgent } = await loadLaunchModule();
  const result = await launchAgent(
    { name: 'adhoc', harness: 'claude', model: 'sonnet', headless: true, pty: false, tag: 'claude' },
    {},
    '/repo',
    new Map(),
    undefined, // no launchedBy
    1,
    false,
    { policy: { enabled: true, attentionAfterSec: 180, escalateAfterSec: 360 } },
  );

  assert.match(result.supervisionNote, /supervision skipped.*sender_name/);
  assert.equal(result.supervision, undefined);
  assert.equal(calls.filter((a) => a[0] === 'events' && a[1] === 'sub').length, 0);
});

test('install failures persist installErrors on the record so the sweep sees the degraded push lane', async (t) => {
  t.mock.module('node:os', { namedExports: { homedir: () => HOME } });
  mockHcom(t, {
    execHcom: async (args) => {
      if (args[0] === 'events' && args[1] === 'sub') {
        return { exitCode: 1, stdout: '', stderr: 'hcom sub failed' };
      }
      return { exitCode: 0, stdout: LAUNCH_OK, stderr: '' };
    },
  });
  mockConfig(t, {});
  seedRegistry([]);

  const { registerLaunchTool } = await loadLaunchModule();
  const server = createFakeServer();
  registerLaunchTool(server);

  const response = await server.handlers.get('launch')({
    harness: 'claude',
    model: 'sonnet',
    sender_name: 'nora',
  });
  assert.equal(response.isError, undefined);
  const payload = JSON.parse(response.content[0].text);
  assert.equal(payload.supervision.agents[0].errors.length, 2);

  const [record] = readRegistry().records;
  assert.equal(record.supervision.subscriptions.length, 0);
  assert.equal(record.supervision.installErrors.length, 2);
  assert.match(record.supervision.installErrors[0], /^life:/);
});

test('an addRecord failure unsubscribes fresh subscriptions before rethrowing', async (t) => {
  t.mock.module('node:os', { namedExports: { homedir: () => HOME } });
  const calls = [];
  mockHcom(t, {
    execHcom: async (args) => {
      calls.push(args);
      if (args[0] === 'events' && args[1] === 'sub') {
        return { exitCode: 0, stdout: SUB_OK, stderr: '' };
      }
      return { exitCode: 0, stdout: LAUNCH_OK, stderr: '' };
    },
  });
  mockConfig(t, {});
  // Corrupt registry: addRecord -> loadRegistry throws RegistryError after
  // quarantining the bad record.
  realFs.mkdirSync(join(HOME, '.hcom', 'mcp'), { recursive: true });
  writeFileSync(REGISTRY_PATH(), JSON.stringify({ records: [{ garbage: true }] }), 'utf-8');

  const { registerLaunchTool } = await loadLaunchModule();
  const server = createFakeServer();
  registerLaunchTool(server);

  const response = await server.handlers.get('launch')({
    harness: 'claude',
    model: 'sonnet',
    sender_name: 'nora',
  });
  assert.equal(response.isError, true);
  // Both freshly-installed subs were rolled back recordless.
  const unsubs = calls.filter((a) => a[0] === 'events' && a[1] === 'unsub');
  assert.deepEqual(unsubs.map((a) => a[2]), ['sub-abc123', 'sub-abc123']);
});
