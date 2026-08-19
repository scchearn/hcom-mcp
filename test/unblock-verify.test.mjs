import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// gate.js is pure (no hcom/registry/config imports) and is never mocked, so a
// static import is safe. Everything that transitively imports hcom.js or
// registry.js must be loaded dynamically AFTER mocks are registered, or the
// real modules land in the cache first and the mocks never apply.
import { parseLaunchGateResult, parseLifeEvents, parseTermJson } from '../dist/gate.js';

let importCounter = 0;
async function loadModule(path) {
  importCounter += 1;
  return import(`../dist/${path}?${importCounter}`);
}

function createFakeServer() {
  const names = [];
  const handlers = new Map();
  return {
    names,
    handlers,
    tool(name, _description, _schema, handler) {
      names.push(name);
      handlers.set(name, handler);
    },
  };
}

const TRUST_DETAIL =
  'launch blocked: screen settled before readiness; run `hcom term waka`\n' +
  "Claude Code'll be able to read, edit, and execute files here.\n" +
  'Security guide\n' +
  '❯ 1. Yes, I trust this folder\n' +
  '2. No, exit\n' +
  'Enter to confirm · Esc to cancel';

const BLOCKED_EVENT_JSON = JSON.stringify([
  {
    data: {
      action: 'launch_blocked',
      batch_id: 'batch-77',
      detail: TRUST_DETAIL,
      reason: 'screen_settled_not_ready',
      status: 'blocked',
    },
    id: 1,
    instance: 'waka',
    ts: '2026-08-19T00:00:00',
    type: 'life',
  },
]);

const READY_EVENT_JSON = JSON.stringify([
  {
    data: { action: 'ready', batch_id: 'batch-77', status: 'listening' },
    id: 2,
    instance: 'waka',
    ts: '2026-08-19T00:00:01',
    type: 'life',
  },
]);

const SCREEN_JSON = JSON.stringify({
  lines: ['❯ 1. Yes, I trust this folder', '2. No, exit', 'Enter to confirm · Esc to cancel'],
  size: { rows: 24, cols: 80 },
  ready: false,
  prompt_empty: false,
  input_text: '',
});

// --- gate parsing (pure) ---

test('parseLaunchGateResult maps exit 0 to ready', () => {
  const result = parseLaunchGateResult('{"data":{"status":"ready"}}', 0);
  assert.equal(result.outcome, 'ready');
});

test('parseLaunchGateResult maps exit 1 to failed with reason', () => {
  const result = parseLaunchGateResult('{"data":{"reason":"no launches"}}', 1);
  assert.equal(result.outcome, 'failed');
  assert.equal(result.reason, 'no launches');
});

test('parseLaunchGateResult disambiguates exit 2 with a launch_blocked life event', () => {
  const result = parseLaunchGateResult(BLOCKED_EVENT_JSON, 2);
  assert.equal(result.outcome, 'blocked');
  assert.match(result.detail, /trust this folder/i);
});

test('parseLaunchGateResult maps exit 2 without a blocked event to timeout', () => {
  const result = parseLaunchGateResult('{"data":{"reason":"timeout after 60s"}}', 2);
  assert.equal(result.outcome, 'timeout');
  assert.equal(result.reason, 'timeout after 60s');
});

test('parseLifeEvents handles bare arrays, data wrappers, and nested events', () => {
  const bare = parseLifeEvents(BLOCKED_EVENT_JSON);
  assert.equal(bare[0].action, 'launch_blocked');
  assert.equal(bare[0].detail, TRUST_DETAIL);

  const wrapped = parseLifeEvents(JSON.stringify({ data: JSON.parse(BLOCKED_EVENT_JSON) }));
  assert.equal(wrapped[0].action, 'launch_blocked');

  const nested = parseLifeEvents(JSON.stringify({ events: JSON.parse(BLOCKED_EVENT_JSON) }));
  assert.equal(nested[0].action, 'launch_blocked');

  assert.deepEqual(parseLifeEvents('not json'), []);
});

test('parseTermJson parses JSON screens and falls back for non-JSON', () => {
  const parsed = parseTermJson(SCREEN_JSON);
  assert.equal(parsed.lines[0], '❯ 1. Yes, I trust this folder');

  const fallback = parseTermJson('plain text screen');
  assert.deepEqual(fallback.lines, ['plain text screen']);
});

// --- rescue allowlist (config + matching) ---

test('rescue allowlist defaults include the claude workspace trust dialog', async () => {
  const { loadMergedConfig } = await import('../dist/config.js?' + Date.now());
  const config = loadMergedConfig(process.cwd());
  assert.equal(config.rescueAllowlist.enabled, true);
  assert.ok(config.rescueAllowlist.patterns.some((p) => /trust this folder/i.test(p)));
});

test('workspace overlay extends rescue allowlist patterns over defaults', async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), 'hcom-mcp-allowlist-'));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  writeFileSync(
    join(workspace, '.hcom-mcp.json'),
    JSON.stringify({
      rescueAllowlist: { patterns: ['custom dialog'] },
    }),
  );

  const { loadMergedConfig } = await import('../dist/config.js?' + Date.now());
  const config = loadMergedConfig(workspace);
  assert.ok(config.rescueAllowlist.patterns.includes('custom dialog'));
  assert.ok(config.rescueAllowlist.patterns.some((p) => /trust this folder/i.test(p)));
});

test('isRescuableDetail matches the trust dialog case-insensitively', async () => {
  const { isRescuableDetail } = await import('../dist/tools/unblock.js?' + Date.now());
  const patterns = ['trust this folder', 'permission mode'];
  assert.equal(isRescuableDetail(TRUST_DETAIL, patterns), true);
  assert.equal(isRescuableDetail('some unrelated screen', patterns), false);
  assert.equal(isRescuableDetail(undefined, patterns), false);
  assert.equal(isRescuableDetail('', patterns), false);
});

// --- unblock tool ---

function mockUnblockDeps(t, { execHcom, records, callerName, allowlist, liveStatus = 'blocked' }) {
  const liveAgents = [{ name: 'waka', base_name: 'waka', status: liveStatus }];
  t.mock.module('../dist/hcom.js', {
    namedExports: {
      resolveCallerName: async (override) => override ?? callerName,
      execHcom: execHcom,
      listHcomAgents: async () => liveAgents,
      findLiveAgentByIdentifier: (id, agents) =>
        agents.find((a) => a.name === id || a.base_name === id) ?? null,
      canonicalizeAgentName: (id, agents) =>
        agents.find((a) => a.name === id || a.base_name === id)?.base_name ??
        (id.startsWith('@') ? id.slice(1) : id),
    },
  });
  t.mock.module('../dist/registry.js', {
    namedExports: {
      getOwnedRecordsByWorkspace: () => records,
      updateRecordState: (id, state) => {
        transitions.push({ id, state });
        return { id, state };
      },
    },
  });
  t.mock.module('../dist/config.js', {
    namedExports: {
      loadMergedConfig: () => ({
        agentPresets: {},
        topologyPresets: {},
        rescueAllowlist: allowlist,
      }),
    },
  });
  // lifecycle.js is loaded (real) by earlier test files; mock its export so
  // the unblock tests exercise the unblock-specific guards, not lifecycle's
  // own hcom/registry bindings.
  t.mock.module('../dist/tools/lifecycle.js', {
    namedExports: {
      validateStopKillTarget: async (name, action, senderName, workspace) => {
        const caller = senderName ?? callerName;
        const canonicalName = name.startsWith('@') ? name.slice(1) : name;
        if (caller === canonicalName) {
          return {
            ok: false,
            response: {
              content: [{ type: 'text', text: `Cannot ${action} the calling hub agent` }],
              isError: true,
            },
          };
        }
        const owned = records.find((r) => r.hcomName === canonicalName);
        if (!owned) {
          return {
            ok: false,
            response: {
              content: [{
                type: 'text',
                text: `Agent "${name}" is not managed. Use adopt tool first to take ownership.`,
              }],
              isError: true,
            },
          };
        }
        return { ok: true, cwd: workspace, owned, liveAgent: null, canonicalName };
      },
    },
  });
  const transitions = [];
  return { transitions };
}

function baseRecord(overrides = {}) {
  return {
    id: 'rec-1',
    workspace: '/repo',
    harness: 'claude',
    hcomName: 'waka',
    preset: 'adhoc',
    launchMode: 'headless',
    state: 'managed_blocked',
    createdAt: '2026-08-01T00:00:00.000Z',
    lastSeenAt: '2026-08-01T00:00:00.000Z',
    released: false,
    ...overrides,
  };
}

const DEFAULT_ALLOWLIST = {
  enabled: true,
  patterns: ['trust this folder', 'permission mode', 'select a model', 'choose a provider'],
};

test('unblock dry-run reports screen tail and blocked detail without injecting', async (t) => {
  const injected = [];
  const execHcom = async (args) => {
    if (args[0] === 'term' && args[1] === 'inject') {
      injected.push(args);
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    if (args[0] === 'term') return { exitCode: 0, stdout: SCREEN_JSON, stderr: '' };
    if (args[0] === 'events' && args[1] === '--last') {
      return { exitCode: 0, stdout: BLOCKED_EVENT_JSON, stderr: '' };
    }
    throw new Error(`unexpected args: ${args.join(' ')}`);
  };
  mockUnblockDeps(t, {
    execHcom,
    records: [baseRecord()],
    callerName: 'nora',
    allowlist: DEFAULT_ALLOWLIST,
  });

  const { registerUnblockTool } = await loadModule('tools/unblock.js');
  const server = createFakeServer();
  registerUnblockTool(server);

  const response = await server.handlers.get('unblock')({
    name: 'waka',
    workspace: '/repo',
    sender_name: 'nora',
  });

  assert.equal(response.isError, undefined);
  const payload = JSON.parse(response.content[0].text);
  assert.equal(payload.dryRun, true);
  assert.match(payload.blockedDetail, /trust this folder/i);
  assert.match(payload.screenTail, /Yes, I trust this folder/);
  assert.deepEqual(injected, []);
});

test('unblock refuses when the agent is not blocked', async (t) => {
  const execHcom = async () => {
    throw new Error('execHcom should not be called for a non-blocked agent');
  };
  mockUnblockDeps(t, {
    execHcom,
    records: [baseRecord()],
    callerName: 'nora',
    allowlist: DEFAULT_ALLOWLIST,
    liveStatus: 'listening',
  });

  const { registerUnblockTool } = await loadModule('tools/unblock.js');
  const server = createFakeServer();
  registerUnblockTool(server);

  const response = await server.handlers.get('unblock')({
    name: 'waka',
    workspace: '/repo',
    sender_name: 'nora',
  });

  assert.equal(response.isError, true);
  assert.match(response.content[0].text, /not blocked/i);
});

test('unblock refuses when the agent is not owned', async (t) => {
  const execHcom = async () => {
    throw new Error('execHcom should not be called for an unowned agent');
  };
  mockUnblockDeps(t, {
    execHcom,
    records: [],
    callerName: 'nora',
    allowlist: DEFAULT_ALLOWLIST,
  });

  const { registerUnblockTool } = await loadModule('tools/unblock.js');
  const server = createFakeServer();
  registerUnblockTool(server);

  const response = await server.handlers.get('unblock')({
    name: 'waka',
    workspace: '/repo',
    sender_name: 'nora',
  });

  assert.equal(response.isError, true);
  assert.match(response.content[0].text, /not managed/i);
});

test('unblock refuses the calling hub agent', async (t) => {
  const execHcom = async () => {
    throw new Error('execHcom should not be called for hub self-protection');
  };
  mockUnblockDeps(t, {
    execHcom,
    records: [baseRecord({ hcomName: 'nora' })],
    callerName: 'nora',
    allowlist: DEFAULT_ALLOWLIST,
  });

  const { registerUnblockTool } = await loadModule('tools/unblock.js');
  const server = createFakeServer();
  registerUnblockTool(server);

  const response = await server.handlers.get('unblock')({
    name: 'nora',
    workspace: '/repo',
    sender_name: 'nora',
  });

  assert.equal(response.isError, true);
  assert.match(response.content[0].text, /hub agent/i);
});

test('unblock live injection rescues a trust dialog and transitions managed_blocked -> managed_active', async (t) => {
  const injected = [];
  const execHcom = async (args) => {
    if (args[0] === 'term' && args[1] === 'inject') {
      injected.push(args);
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    if (args[0] === 'term') return { exitCode: 0, stdout: SCREEN_JSON, stderr: '' };
    if (args[0] === 'events' && args[1] === '--wait') {
      return { exitCode: 0, stdout: READY_EVENT_JSON, stderr: '' };
    }
    if (args[0] === 'events' && args[1] === '--last') {
      return { exitCode: 0, stdout: BLOCKED_EVENT_JSON, stderr: '' };
    }
    throw new Error(`unexpected args: ${args.join(' ')}`);
  };
  const { transitions } = mockUnblockDeps(t, {
    execHcom,
    records: [baseRecord()],
    callerName: 'nora',
    allowlist: DEFAULT_ALLOWLIST,
  });

  const { registerUnblockTool } = await loadModule('tools/unblock.js');
  const server = createFakeServer();
  registerUnblockTool(server);

  const response = await server.handlers.get('unblock')({
    name: 'waka',
    workspace: '/repo',
    sender_name: 'nora',
    dry_run: false,
  });

  assert.equal(response.isError, undefined);
  const payload = JSON.parse(response.content[0].text);
  assert.equal(payload.injected, true);
  assert.equal(payload.recheck.state, 'ready');
  assert.equal(payload.registryTransition, 'managed_blocked -> managed_active');
  assert.deepEqual(injected, [['term', 'inject', 'waka', '--enter']]);
  assert.deepEqual(transitions, [{ id: 'rec-1', state: 'managed_active' }]);
});

test('unblock live injection refuses when the blocked detail is not on the allowlist', async (t) => {
  const injected = [];
  const execHcom = async (args) => {
    if (args[0] === 'term' && args[1] === 'inject') {
      injected.push(args);
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    if (args[0] === 'term') return { exitCode: 0, stdout: SCREEN_JSON, stderr: '' };
    if (args[0] === 'events' && args[1] === '--last') {
      return { exitCode: 0, stdout: BLOCKED_EVENT_JSON, stderr: '' };
    }
    throw new Error(`unexpected args: ${args.join(' ')}`);
  };
  const { transitions } = mockUnblockDeps(t, {
    execHcom,
    records: [baseRecord()],
    callerName: 'nora',
    allowlist: { enabled: true, patterns: ['permission mode'] },
  });

  const { registerUnblockTool } = await loadModule('tools/unblock.js');
  const server = createFakeServer();
  registerUnblockTool(server);

  const response = await server.handlers.get('unblock')({
    name: 'waka',
    workspace: '/repo',
    sender_name: 'nora',
    dry_run: false,
  });

  assert.equal(response.isError, true);
  assert.match(response.content[0].text, /does not match any rescue allowlist pattern/i);
  assert.deepEqual(injected, []);
  assert.deepEqual(transitions, []);
});

test('unblock live injection refuses when the allowlist is disabled', async (t) => {
  const injected = [];
  const execHcom = async (args) => {
    if (args[0] === 'term' && args[1] === 'inject') {
      injected.push(args);
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    if (args[0] === 'term') return { exitCode: 0, stdout: SCREEN_JSON, stderr: '' };
    if (args[0] === 'events' && args[1] === '--last') {
      return { exitCode: 0, stdout: BLOCKED_EVENT_JSON, stderr: '' };
    }
    throw new Error(`unexpected args: ${args.join(' ')}`);
  };
  mockUnblockDeps(t, {
    execHcom,
    records: [baseRecord()],
    callerName: 'nora',
    allowlist: { enabled: false, patterns: ['trust this folder'] },
  });

  const { registerUnblockTool } = await loadModule('tools/unblock.js');
  const server = createFakeServer();
  registerUnblockTool(server);

  const response = await server.handlers.get('unblock')({
    name: 'waka',
    workspace: '/repo',
    sender_name: 'nora',
    dry_run: false,
  });

  assert.equal(response.isError, true);
  assert.match(response.content[0].text, /allowlist is disabled/i);
  assert.deepEqual(injected, []);
});

test('unblock reports a failed injection without a registry transition', async (t) => {
  const execHcom = async (args) => {
    if (args[0] === 'term' && args[1] === 'inject') {
      return { exitCode: 1, stdout: '', stderr: 'inject failed' };
    }
    if (args[0] === 'term') return { exitCode: 0, stdout: SCREEN_JSON, stderr: '' };
    if (args[0] === 'events' && args[1] === '--last') {
      return { exitCode: 0, stdout: BLOCKED_EVENT_JSON, stderr: '' };
    }
    throw new Error(`unexpected args: ${args.join(' ')}`);
  };
  const { transitions } = mockUnblockDeps(t, {
    execHcom,
    records: [baseRecord()],
    callerName: 'nora',
    allowlist: DEFAULT_ALLOWLIST,
  });

  const { registerUnblockTool } = await loadModule('tools/unblock.js');
  const server = createFakeServer();
  registerUnblockTool(server);

  const response = await server.handlers.get('unblock')({
    name: 'waka',
    workspace: '/repo',
    sender_name: 'nora',
    dry_run: false,
  });

  assert.equal(response.isError, true);
  assert.match(response.content[0].text, /Injection failed/i);
  assert.deepEqual(transitions, []);
});

test('unblock keeps the record blocked when the agent is still blocked after one Enter', async (t) => {
  const execHcom = async (args) => {
    if (args[0] === 'term' && args[1] === 'inject') {
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    if (args[0] === 'term') return { exitCode: 0, stdout: SCREEN_JSON, stderr: '' };
    if (args[0] === 'events' && args[1] === '--wait') {
      return { exitCode: 2, stdout: '', stderr: 'timeout' };
    }
    if (args[0] === 'events' && args[1] === '--last') {
      return { exitCode: 0, stdout: BLOCKED_EVENT_JSON, stderr: '' };
    }
    throw new Error(`unexpected args: ${args.join(' ')}`);
  };
  const { transitions } = mockUnblockDeps(t, {
    execHcom,
    records: [baseRecord()],
    callerName: 'nora',
    allowlist: DEFAULT_ALLOWLIST,
  });

  const { registerUnblockTool } = await loadModule('tools/unblock.js');
  const server = createFakeServer();
  registerUnblockTool(server);

  const response = await server.handlers.get('unblock')({
    name: 'waka',
    workspace: '/repo',
    sender_name: 'nora',
    dry_run: false,
  });

  assert.equal(response.isError, undefined);
  const payload = JSON.parse(response.content[0].text);
  assert.equal(payload.recheck.state, 'blocked');
  assert.equal(payload.registryTransition, 'none');
  assert.deepEqual(transitions, []);
});

// --- spawn_and_verify ---

function mockVerifyDeps(t, { execHcom, runUnblock, allowlist, config }) {
  const stateUpdates = [];
  const verifyUpdates = [];
  t.mock.module('../dist/hcom.js', {
    namedExports: {
      resolveCallerName: async (override) => override,
      execHcom: execHcom,
      listHarnessModels: async (harness) => {
        const models = { claude: ['sonnet'], opencode: ['opencode/deepseek-v4-flash-free'] };
        const available = models[harness] || [];
        return [{ harness, status: 'live', source: 'mock', models: available, count: available.length }];
      },
    },
  });
  t.mock.module('../dist/registry.js', {
    namedExports: {
      addRecord: (record) => ({ ...record, id: 'record-1' }),
      removeRecords: () => {},
      updateRecordState: (id, state) => {
        stateUpdates.push({ id, state });
        return { id, state };
      },
      updateRecordVerify: (id, info) => {
        verifyUpdates.push({ id, info });
        return { id, ...info };
      },
    },
  });
  t.mock.module('../dist/config.js', {
    namedExports: {
      loadMergedConfig: () =>
        config ?? {
          agentPresets: {},
          topologyPresets: {},
          rescueAllowlist: allowlist ?? { enabled: true, patterns: ['trust this folder'] },
        },
      resolveAgentPreset: (cfg, name) => cfg.agentPresets[name] || null,
      resolveTopologyPreset: (cfg, name) => cfg.topologyPresets[name] || null,
      validateTopologyReferences: () => [],
    },
  });
  if (runUnblock) {
    t.mock.module('../dist/tools/unblock.js', {
      namedExports: { runUnblock },
    });
  }
  return { stateUpdates, verifyUpdates };
}

test('spawn_and_verify reports ready and persists the outcome', async (t) => {
  const execHcom = async (args) => {
    if (args[0] === 'events' && args[1] === 'launch') {
      return { exitCode: 0, stdout: '{"data":{"status":"ready"}}', stderr: '' };
    }
    if (args[0] === 'opencode') {
      return { exitCode: 0, stdout: 'Names: waka\nBatch id: batch-77\n', stderr: '' };
    }
    throw new Error(`unexpected args: ${args.join(' ')}`);
  };
  const { stateUpdates, verifyUpdates } = mockVerifyDeps(t, { execHcom });

  const { registerSpawnAndVerifyTool } = await loadModule('tools/launch.js');
  const server = createFakeServer();
  registerSpawnAndVerifyTool(server);

  const response = await server.handlers.get('spawn_and_verify')({
    harness: 'opencode',
    model: 'opencode/deepseek-v4-flash-free',
    sender_name: 'nora',
    ready_timeout_sec: 30,
  });

  assert.equal(response.isError, undefined);
  const payload = JSON.parse(response.content[0].text);
  assert.equal(payload.summary.ready, 1);
  assert.equal(payload.summary.total, 1);
  assert.equal(payload.outcomes[0].outcome, 'ready');
  assert.equal(payload.outcomes[0].rescued, false);
  assert.equal(typeof payload.outcomes[0].latencyMs, 'number');
  assert.deepEqual(stateUpdates, [{ id: 'record-1', state: 'managed_active' }]);
  assert.equal(verifyUpdates.length, 1);
  assert.equal(verifyUpdates[0].info.outcome, 'ready');
});

test('spawn_and_verify classifies a blocked agent and includes the screen tail', async (t) => {
  const execHcom = async (args) => {
    if (args[0] === 'events' && args[1] === 'launch') {
      return { exitCode: 2, stdout: BLOCKED_EVENT_JSON, stderr: '' };
    }
    if (args[0] === 'term') return { exitCode: 0, stdout: SCREEN_JSON, stderr: '' };
    if (args[0] === 'opencode') {
      return { exitCode: 2, stdout: 'Names: waka\nBatch id: batch-77\n', stderr: '' };
    }
    throw new Error(`unexpected args: ${args.join(' ')}`);
  };
  const { stateUpdates } = mockVerifyDeps(t, { execHcom });

  const { registerSpawnAndVerifyTool } = await loadModule('tools/launch.js');
  const server = createFakeServer();
  registerSpawnAndVerifyTool(server);

  const response = await server.handlers.get('spawn_and_verify')({
    harness: 'opencode',
    model: 'opencode/deepseek-v4-flash-free',
    sender_name: 'nora',
    on_blocked: 'report',
  });

  assert.equal(response.isError, undefined);
  const payload = JSON.parse(response.content[0].text);
  assert.equal(payload.summary.blocked, 1);
  assert.equal(payload.outcomes[0].outcome, 'blocked');
  assert.match(payload.outcomes[0].detail, /trust this folder/i);
  assert.match(payload.outcomes[0].screenTail, /Yes, I trust this folder/);
  assert.deepEqual(stateUpdates, [{ id: 'record-1', state: 'managed_blocked' }]);
});

test('spawn_and_verify rescues a blocked agent and transitions to active', async (t) => {
  const execHcom = async (args) => {
    if (args[0] === 'events' && args[1] === 'launch') {
      return { exitCode: 2, stdout: BLOCKED_EVENT_JSON, stderr: '' };
    }
    if (args[0] === 'opencode') {
      return { exitCode: 2, stdout: 'Names: waka\nBatch id: batch-77\n', stderr: '' };
    }
    throw new Error(`unexpected args: ${args.join(' ')}`);
  };
  const rescueCalls = [];
  const runUnblock = async (name, options) => {
    rescueCalls.push({ name, options });
    return { ok: true, state: 'ready', text: 'rescued' };
  };
  const { stateUpdates } = mockVerifyDeps(t, { execHcom, runUnblock });

  const { registerSpawnAndVerifyTool } = await loadModule('tools/launch.js');
  const server = createFakeServer();
  registerSpawnAndVerifyTool(server);

  const response = await server.handlers.get('spawn_and_verify')({
    harness: 'opencode',
    model: 'opencode/deepseek-v4-flash-free',
    sender_name: 'nora',
    on_blocked: 'rescue',
  });

  assert.equal(response.isError, undefined);
  const payload = JSON.parse(response.content[0].text);
  assert.equal(payload.summary.ready, 1);
  assert.equal(payload.outcomes[0].outcome, 'ready');
  assert.equal(payload.outcomes[0].rescued, true);
  assert.equal(rescueCalls.length, 1);
  assert.equal(rescueCalls[0].name, 'waka');
  assert.equal(rescueCalls[0].options.dryRun, false);
  assert.equal(rescueCalls[0].options.workspace, process.cwd());
  assert.deepEqual(stateUpdates, [{ id: 'record-1', state: 'managed_active' }]);
});

test('spawn_and_verify maps a failed gate to managed_lost', async (t) => {
  const execHcom = async (args) => {
    if (args[0] === 'events' && args[1] === 'launch') {
      return { exitCode: 1, stdout: '{"data":{"reason":"launch failed"}}', stderr: '' };
    }
    if (args[0] === 'term') return { exitCode: 0, stdout: SCREEN_JSON, stderr: '' };
    if (args[0] === 'opencode') {
      return { exitCode: 0, stdout: 'Names: waka\nBatch id: batch-77\n', stderr: '' };
    }
    throw new Error(`unexpected args: ${args.join(' ')}`);
  };
  const { stateUpdates } = mockVerifyDeps(t, { execHcom });

  const { registerSpawnAndVerifyTool } = await loadModule('tools/launch.js');
  const server = createFakeServer();
  registerSpawnAndVerifyTool(server);

  const response = await server.handlers.get('spawn_and_verify')({
    harness: 'opencode',
    model: 'opencode/deepseek-v4-flash-free',
    sender_name: 'nora',
  });

  assert.equal(response.isError, undefined);
  const payload = JSON.parse(response.content[0].text);
  assert.equal(payload.summary.failed, 1);
  assert.equal(payload.outcomes[0].outcome, 'failed');
  assert.deepEqual(stateUpdates, [{ id: 'record-1', state: 'managed_lost' }]);
});

test('spawn_and_verify maps a gate timeout to timeout', async (t) => {
  const execHcom = async (args) => {
    if (args[0] === 'events' && args[1] === 'launch') {
      return { exitCode: 2, stdout: '{"data":{"reason":"timeout after 30s"}}', stderr: '' };
    }
    if (args[0] === 'opencode') {
      return { exitCode: 0, stdout: 'Names: waka\nBatch id: batch-77\n', stderr: '' };
    }
    throw new Error(`unexpected args: ${args.join(' ')}`);
  };
  const { stateUpdates } = mockVerifyDeps(t, { execHcom });

  const { registerSpawnAndVerifyTool } = await loadModule('tools/launch.js');
  const server = createFakeServer();
  registerSpawnAndVerifyTool(server);

  const response = await server.handlers.get('spawn_and_verify')({
    harness: 'opencode',
    model: 'opencode/deepseek-v4-flash-free',
    sender_name: 'nora',
  });

  assert.equal(response.isError, undefined);
  const payload = JSON.parse(response.content[0].text);
  assert.equal(payload.summary.timeout, 1);
  assert.equal(payload.outcomes[0].outcome, 'timeout');
  assert.deepEqual(stateUpdates, [{ id: 'record-1', state: 'managed_blocked' }]);
});

test('spawn_and_verify errors when sender_name is missing', async (t) => {
  const execHcom = async () => {
    throw new Error('execHcom should not be called when sender identity is missing');
  };
  mockVerifyDeps(t, { execHcom });

  const { registerSpawnAndVerifyTool } = await loadModule('tools/launch.js');
  const server = createFakeServer();
  registerSpawnAndVerifyTool(server);

  const response = await server.handlers.get('spawn_and_verify')({
    harness: 'opencode',
    model: 'opencode/deepseek-v4-flash-free',
  });

  assert.equal(response.isError, true);
  assert.match(response.content[0].text, /sender_name/i);
});

test('launch_topology with verify=true gates each agent and reports outcomes', async (t) => {
  let launchCount = 0;
  const execHcom = async (args) => {
    if (args[0] === 'events' && args[1] === 'launch') {
      return { exitCode: 0, stdout: '{"data":{"status":"ready"}}', stderr: '' };
    }
    if (args[0] === 'claude') {
      launchCount += 1;
      return {
        exitCode: 0,
        stdout: `Names: worker-${launchCount}\nBatch id: batch-${launchCount}\n`,
        stderr: '',
      };
    }
    throw new Error(`unexpected args: ${args.join(' ')}`);
  };
  const { stateUpdates } = mockVerifyDeps(t, {
    execHcom,
    config: {
      agentPresets: {
        reviewer: {
          name: 'reviewer',
          harness: { claude: { model: 'sonnet' } },
          headless: true,
          pty: false,
        },
      },
      topologyPresets: {
        swarm: {
          name: 'swarm',
          roles: [{ role: 'review', preset: 'reviewer', harness: 'claude', count: 2 }],
        },
      },
      rescueAllowlist: { enabled: true, patterns: ['trust this folder'] },
    },
  });

  const { registerTopologyLaunchTool } = await loadModule('tools/launch.js');
  const server = createFakeServer();
  registerTopologyLaunchTool(server);

  const response = await server.handlers.get('launch_topology')({
    topology: 'swarm',
    workspace: '/repo',
    sender_name: 'nora',
    verify: true,
  });

  assert.equal(response.isError, undefined);
  const payload = JSON.parse(response.content[0].text);
  assert.equal(payload.totalAgents, 2);
  assert.equal(payload.verifyOutcomes.length, 2);
  assert.ok(payload.verifyOutcomes.every((o) => o.outcome === 'ready'));
  assert.equal(stateUpdates.length, 2);
  assert.ok(stateUpdates.every((u) => u.state === 'managed_active'));
});

test('launch_topology without verify does not gate', async (t) => {
  let launchCount = 0;
  const execHcom = async (args) => {
    if (args[0] === 'events' && args[1] === 'launch') {
      throw new Error('gate should not run without verify=true');
    }
    if (args[0] === 'claude') {
      launchCount += 1;
      return {
        exitCode: 0,
        stdout: `Names: worker-${launchCount}\nBatch id: batch-${launchCount}\n`,
        stderr: '',
      };
    }
    throw new Error(`unexpected args: ${args.join(' ')}`);
  };
  const { stateUpdates } = mockVerifyDeps(t, {
    execHcom,
    config: {
      agentPresets: {
        reviewer: {
          name: 'reviewer',
          harness: { claude: { model: 'sonnet' } },
          headless: true,
          pty: false,
        },
      },
      topologyPresets: {
        swarm: {
          name: 'swarm',
          roles: [{ role: 'review', preset: 'reviewer', harness: 'claude', count: 1 }],
        },
      },
      rescueAllowlist: { enabled: true, patterns: ['trust this folder'] },
    },
  });

  const { registerTopologyLaunchTool } = await loadModule('tools/launch.js');
  const server = createFakeServer();
  registerTopologyLaunchTool(server);

  const response = await server.handlers.get('launch_topology')({
    topology: 'swarm',
    workspace: '/repo',
    sender_name: 'nora',
  });

  assert.equal(response.isError, undefined);
  const payload = JSON.parse(response.content[0].text);
  assert.equal(payload.verifyOutcomes, undefined);
  assert.equal(stateUpdates.length, 0);
});
