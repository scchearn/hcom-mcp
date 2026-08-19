import test from 'node:test';
import assert from 'node:assert/strict';

// Pure helpers import statically (no side effects at import time).
import { canonicalizeAgentName, findLiveAgentByIdentifier } from '../dist/hcom.js';

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

const LIVE_AGENTS = [
  { name: 'w3-vade', base_name: 'vade', status: 'listening', tag: 'w3', tool: 'opencode' },
  { name: 'team-waka', base_name: 'waka', status: 'listening', tag: 'team', tool: 'claude' },
  { name: 'zago', base_name: 'zago', status: 'listening', tag: null, tool: 'claude' },
  { name: 'solo:KELU', base_name: 'solo:KELU', status: 'listening', tag: null, tool: 'opencode' },
];

function baseRecord(overrides = {}) {
  return {
    id: 'rec-1',
    workspace: '/repo',
    harness: 'claude',
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

// --- canonicalizeAgentName (pure) ---

test('canonicalizeAgentName strips a leading @', () => {
  assert.equal(canonicalizeAgentName('@waka', LIVE_AGENTS), 'waka');
});

test('canonicalizeAgentName resolves a live display name to its base name', () => {
  assert.equal(canonicalizeAgentName('team-waka', LIVE_AGENTS), 'waka');
});

test('canonicalizeAgentName passes a bare base name through unchanged', () => {
  assert.equal(canonicalizeAgentName('waka', LIVE_AGENTS), 'waka');
});

test('canonicalizeAgentName strips a tag prefix when the tag is live', () => {
  assert.equal(canonicalizeAgentName('team-worker', LIVE_AGENTS), 'worker');
});

test('canonicalizeAgentName leaves remote name:DEVICE forms untouched', () => {
  assert.equal(canonicalizeAgentName('solo:KELU', LIVE_AGENTS), 'solo:KELU');
});

test('canonicalizeAgentName leaves unknown names unchanged so errors stay honest', () => {
  assert.equal(canonicalizeAgentName('ghost', LIVE_AGENTS), 'ghost');
  assert.equal(canonicalizeAgentName('nope-worker', LIVE_AGENTS), 'nope-worker');
});

test('canonicalizeAgentName returns empty for an @-only name', () => {
  assert.equal(canonicalizeAgentName('@', LIVE_AGENTS), '');
});

// --- #12-B1: self-protection holds against tag-prefixed forms ---

function mockLifecycleDeps(t, { records, callerName, execHcom }) {
  t.mock.module('../dist/hcom.js', {
    namedExports: {
      resolveCallerName: async (override) => override ?? callerName,
      listHcomAgents: async () => LIVE_AGENTS,
      findLiveAgentByIdentifier: (id, agents) =>
        agents.find((a) => a.name === id || a.base_name === id) ?? null,
      canonicalizeAgentName: (id, agents) =>
        agents.find((a) => a.name === id || a.base_name === id)?.base_name ??
        (id.startsWith('@') ? id.slice(1) : id),
      execHcom: execHcom,
    },
  });
  t.mock.module('../dist/registry.js', {
    namedExports: {
      getOwnedRecordsByWorkspace: () => records,
      updateRecordState: () => null,
    },
  });
}

test('kill refuses the hub killing its own tag-prefixed form', async (t) => {
  const execHcom = async () => {
    throw new Error('execHcom should not be called for hub self-protection');
  };
  mockLifecycleDeps(t, {
    records: [baseRecord({ hcomName: 'vade' })],
    execHcom,
  });

  const { registerLifecycleTools } = await loadModule('tools/lifecycle.js');
  const server = createFakeServer();
  registerLifecycleTools(server);

  // The exact #12-B1 bypass: the hub's caller identity IS its tag-prefixed
  // display form, and it targets that same form.
  const response = await server.handlers.get('kill')({
    name: 'w3-vade',
    workspace: '/repo',
    sender_name: 'w3-vade',
  });

  assert.equal(response.isError, true);
  assert.match(response.content[0].text, /calling hub agent/i);
});

test('kill refuses the hub killing its own bare form via a tag-prefixed target', async (t) => {
  const execHcom = async () => {
    throw new Error('execHcom should not be called for hub self-protection');
  };
  mockLifecycleDeps(t, {
    records: [baseRecord({ hcomName: 'vade' })],
    execHcom,
  });

  const { registerLifecycleTools } = await loadModule('tools/lifecycle.js');
  const server = createFakeServer();
  registerLifecycleTools(server);

  const response = await server.handlers.get('kill')({
    name: 'w3-vade',
    workspace: '/repo',
    sender_name: 'vade',
  });

  assert.equal(response.isError, true);
  assert.match(response.content[0].text, /calling hub agent/i);
});

test('stop refuses to the hub stopping its own tag-prefixed form', async (t) => {
  const execHcom = async () => {
    throw new Error('execHcom should not be called for hub self-protection');
  };
  mockLifecycleDeps(t, {
    records: [baseRecord({ hcomName: 'vade' })],
    execHcom,
  });

  const { registerLifecycleTools } = await loadModule('tools/lifecycle.js');
  const server = createFakeServer();
  registerLifecycleTools(server);

  const response = await server.handlers.get('stop')({
    name: 'w3-vade',
    workspace: '/repo',
    sender_name: 'vade',
  });

  assert.equal(response.isError, true);
  assert.match(response.content[0].text, /hub agent/i);
});

test('unblock refuses the hub unblocking its own tag-prefixed form', async (t) => {
  const execHcom = async () => {
    throw new Error('execHcom should not be called for hub self-protection');
  };
  mockLifecycleDeps(t, {
    records: [baseRecord({ hcomName: 'vade', state: 'managed_blocked' })],
    execHcom,
  });
  t.mock.module('../dist/config.js', {
    namedExports: {
      loadMergedConfig: () => ({
        agentPresets: {},
        topologyPresets: {},
        rescueAllowlist: { enabled: true, patterns: ['trust this folder'] },
      }),
    },
  });

  const { runUnblock } = await loadModule('tools/unblock.js');
  const result = await runUnblock('w3-vade', {
    workspace: '/repo',
    sender_name: 'vade',
    dryRun: true,
  });

  assert.equal(result.ok, false);
  assert.equal(result.isError, true);
  assert.match(result.text, /hub agent/i);
});

// --- #2: kill/inspect accept tag-prefixed display names ---

test('kill resolves a tag-prefixed display name to the owned base-name record', async (t) => {
  const calls = [];
  const execHcom = async (args) => {
    calls.push(args);
    return { exitCode: 0, stdout: '', stderr: '' };
  };
  mockLifecycleDeps(t, {
    records: [baseRecord()], // record hcomName is the base name 'waka'
    execHcom,
  });

  const { registerLifecycleTools } = await loadModule('tools/lifecycle.js');
  const server = createFakeServer();
  registerLifecycleTools(server);

  const response = await server.handlers.get('kill')({
    name: 'team-waka',
    workspace: '/repo',
    sender_name: 'nora',
  });

  assert.equal(response.isError, undefined);
  assert.deepEqual(calls, [['kill', 'waka', '--go']]);
});

test('inspect resolves a tag-prefixed display name to the live record', async (t) => {
  t.mock.module('../dist/hcom.js', {
    namedExports: {
      listHcomAgents: async () => LIVE_AGENTS,
      findLiveAgentByIdentifier: (id, agents) =>
        agents.find((a) => a.name === id || a.base_name === id) ?? null,
      canonicalizeAgentName: (id, agents) =>
        agents.find((a) => a.name === id || a.base_name === id)?.base_name ??
        (id.startsWith('@') ? id.slice(1) : id),
      execHcom: async (args) => {
        if (args[0] === 'list') {
          return { exitCode: 0, stdout: JSON.stringify(LIVE_AGENTS[1]), stderr: '' };
        }
        throw new Error(`unexpected args: ${args.join(' ')}`);
      },
      parseHcomJson: JSON.parse,
    },
  });
  t.mock.module('../dist/registry.js', {
    namedExports: {
      getOwnedRecordsByWorkspace: () => [baseRecord()],
    },
  });

  const { registerInspectTool } = await loadModule('tools/inspect.js');
  const server = createFakeServer();
  registerInspectTool(server);

  const response = await server.handlers.get('inspect')({
    name: 'team-waka',
    aspect: 'status',
    workspace: '/repo',
  });

  assert.equal(response.isError, undefined);
  const payload = JSON.parse(response.content[0].text);
  assert.equal(payload.managementStatus, 'managed');
  assert.equal(payload.agent, 'team-waka');
});

// --- #12-B3: adopt idempotency via the live base name ---

test('adopt writes the record under the live base name, not the display name', async (t) => {
  const adopted = [];
  t.mock.module('../dist/hcom.js', {
    namedExports: {
      resolveCallerName: async (override) => override ?? 'nora',
      listHcomAgents: async () => LIVE_AGENTS,
      findLiveAgentByIdentifier: (id, agents) =>
        agents.find((a) => a.name === id || a.base_name === id) ?? null,
      inferHarnessFromTool: (tool) => (tool === 'claude' ? 'claude' : tool === 'opencode' ? 'opencode' : null),
      execHcom: async (args) => {
        sendArgs = args;
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    },
  });
  let sendArgs;
  t.mock.module('../dist/registry.js', {
    namedExports: {
      findRecordByWorkspaceAndName: () => undefined,
      adoptRecord: (params) => {
        adopted.push(params);
        return { ...params, id: 'adopted-1' };
      },
    },
  });

  const { registerAdoptTool } = await loadModule('tools/adopt.js');
  const server = createFakeServer();
  registerAdoptTool(server);

  const response = await server.handlers.get('adopt')({
    name: 'team-waka',
    workspace: '/repo',
    sender_name: 'nora',
  });

  assert.equal(response.isError, undefined);
  assert.equal(adopted.length, 1);
  assert.equal(adopted[0].hcomName, 'waka');
  assert.equal(sendArgs[1], '@waka');
});

test('adopting the same agent via either name form is idempotent', async (t) => {
  const adopted = [];
  const existingRecords = [];
  t.mock.module('../dist/hcom.js', {
    namedExports: {
      resolveCallerName: async (override) => override ?? 'nora',
      listHcomAgents: async () => LIVE_AGENTS,
      findLiveAgentByIdentifier: (id, agents) =>
        agents.find((a) => a.name === id || a.base_name === id) ?? null,
      inferHarnessFromTool: (tool) => (tool === 'claude' ? 'claude' : tool === 'opencode' ? 'opencode' : null),
      execHcom: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    },
  });
  t.mock.module('../dist/registry.js', {
    namedExports: {
      findRecordByWorkspaceAndName: (workspace, name) =>
        existingRecords.find((r) => r.workspace === workspace && r.hcomName === name && !r.released),
      adoptRecord: (params) => {
        adopted.push(params);
        const record = { ...params, id: `adopted-${adopted.length}` };
        existingRecords.push(record);
        return record;
      },
    },
  });

  const { registerAdoptTool } = await loadModule('tools/adopt.js');
  const server = createFakeServer();
  registerAdoptTool(server);

  const first = await server.handlers.get('adopt')({
    name: 'team-waka',
    workspace: '/repo',
    sender_name: 'nora',
  });
  const second = await server.handlers.get('adopt')({
    name: 'waka',
    workspace: '/repo',
    sender_name: 'nora',
  });

  assert.equal(first.isError, undefined);
  assert.equal(second.isError, undefined);
  assert.equal(adopted.length, 1);
  assert.equal(adopted[0].hcomName, 'waka');
  assert.equal(JSON.parse(second.content[0].text).hcomName, 'waka');
});

// --- #12-B4: list_all resolves against the requested workspace ---

test('list_all accepts a workspace param and resolves records against it', async (t) => {
  let queriedWorkspace;
  t.mock.module('../dist/hcom.js', {
    namedExports: {
      listHcomAgents: async () => LIVE_AGENTS,
      findLiveAgentByIdentifier: (id, agents) =>
        agents.find((a) => a.name === id || a.base_name === id) ?? null,
    },
  });
  t.mock.module('../dist/registry.js', {
    namedExports: {
      REGISTRY_PATH: '/tmp/registry.json',
      getOwnedRecordsByWorkspace: (workspace) => {
        queriedWorkspace = workspace;
        return [baseRecord()];
      },
      getRecordsByWorkspace: () => [],
      updateRecordState: () => null,
    },
  });

  const { registerListAllTool } = await loadModule('tools/list.js');
  const server = createFakeServer();
  registerListAllTool(server);

  const response = await server.handlers.get('list_all')({
    workspace: '/repo',
  });

  assert.equal(response.isError, undefined);
  assert.equal(queriedWorkspace, '/repo');
  const payload = JSON.parse(response.content[0].text);
  const waka = payload.agents.find((a) => a.base_name === 'waka');
  assert.equal(waka.managementStatus, 'managed');
});
