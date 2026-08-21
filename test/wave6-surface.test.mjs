import test from 'node:test';
import assert from 'node:assert/strict';

// Wave 6: tool-surface quality pass (#14). Locks the stable error-code
// contract (E_* tokens), the camelCase returned-JSON contract for thread
// tools, the all_workspaces canonical param, and the XS wins (launch count,
// continue_from --compact, transcript omp, list_presets prompt_preview,
// adopt bulk + notice, codex reasoningNote, antigravity model skip).

// Static imports instantiate the real module graph (registry -> hcom) before
// any mock, so dynamic imports of tool modules link against complete mocks.
import { summarizeAgentPresets } from '../dist/config.js';

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
];

// Complete hcom.js mock: every export the tool module graph links against.
function hcomMock(overrides = {}) {
  return {
    resolveCallerName: async (override) => override,
    execHcom: async () => {
      throw new Error('execHcom should not be called');
    },
    listHcomAgents: async () => LIVE_AGENTS,
    findLiveAgentByIdentifier: (id, agents) =>
      agents.find((a) => a.name === id || a.base_name === id) ?? null,
    canonicalizeAgentName: (id) => (id.startsWith('@') ? id.slice(1) : id),
    inferHarnessFromTool: (tool) =>
      tool === 'claude' ? 'claude' : tool === 'opencode' ? 'opencode' : null,
    listHarnessModels: async () => [],
    parseHcomJson: JSON.parse,
    listStoppedAgentNames: async () => [],
    ...overrides,
  };
}

// Complete registry.js mock for tests that must not touch the real registry.
function registryMock(overrides = {}) {
  return {
    REGISTRY_PATH: '/tmp/hcom-mcp-registry.json',
    getOwnedRecordsByWorkspace: () => [],
    getRecordsByWorkspace: () => [],
    addRecord: (record) => ({ ...record, id: 'record-1' }),
    removeRecords: () => {},
    updateRecordState: () => null,
    updateRecordVerify: () => null,
    adoptRecord: (params) => ({ ...params, id: 'adopted-1' }),
    findRecordByWorkspaceAndName: () => undefined,
    pruneRecords: async () => ({ removed: [], wouldRemove: [] }),
    matchLiveAgent: () => null,
    persistReconciledState: () => {},
    resolveRootLauncher: (record) => record.launchedBy,
    reconcileManagedRecords: (records) => records,
    reconcileGlobalRecords: async () => ({ records: [], transitions: [], liveAgents: [], stoppedNames: [] }),
    ...overrides,
  };
}

// --- Stable error-code contract ---

test('launch errors carry the E_NO_SENDER token for unbound callers', async (t) => {
  t.mock.module('../dist/hcom.js', {
    namedExports: hcomMock({ resolveCallerName: async () => undefined }),
  });

  const { registerLaunchTool } = await loadModule('tools/launch.js');
  const server = createFakeServer();
  registerLaunchTool(server);

  const response = await server.handlers.get('launch')({ harness: 'claude', model: 'sonnet' });
  assert.equal(response.isError, true);
  assert.match(response.content[0].text, /^\[E_NO_SENDER\]/);
});

test('send errors carry the E_NO_SENDER token for unbound callers', async (t) => {
  t.mock.module('../dist/hcom.js', {
    namedExports: hcomMock({ resolveCallerName: async () => undefined }),
  });

  const { registerSendTool } = await loadModule('tools/send.js');
  const server = createFakeServer();
  registerSendTool(server);

  const response = await server.handlers.get('send')({ targets: ['@waka'], message: 'hi' });
  assert.equal(response.isError, true);
  assert.match(response.content[0].text, /^\[E_NO_SENDER\]/);
});

test('send ack without reply_to carries the E_ACK_REQUIRES_REPLY_TO token', async (t) => {
  t.mock.module('../dist/hcom.js', {
    namedExports: hcomMock(),
  });

  const { registerSendTool } = await loadModule('tools/send.js');
  const server = createFakeServer();
  registerSendTool(server);

  const response = await server.handlers.get('send')({
    targets: ['@waka'],
    message: 'ok',
    intent: 'ack',
    sender_name: 'nora',
  });
  assert.equal(response.isError, true);
  assert.match(response.content[0].text, /^\[E_ACK_REQUIRES_REPLY_TO\]/);
});

test('launch missing preset carries the E_PRESET_NOT_FOUND token', async () => {
  const server = createFakeServer();
  const { registerLaunchTool } = await loadModule('tools/launch.js');
  registerLaunchTool(server);

  const response = await server.handlers.get('launch')({ preset: 'nope', sender_name: 'nora' });
  assert.equal(response.isError, true);
  assert.match(response.content[0].text, /^\[E_PRESET_NOT_FOUND\]/);
});

test('launch_topology missing topology carries the E_TOPOLOGY_NOT_FOUND token', async () => {
  const server = createFakeServer();
  const { registerTopologyLaunchTool } = await loadModule('tools/launch.js');
  registerTopologyLaunchTool(server);

  const response = await server.handlers.get('launch_topology')({ topology: 'nope', sender_name: 'nora' });
  assert.equal(response.isError, true);
  assert.match(response.content[0].text, /^\[E_TOPOLOGY_NOT_FOUND\]/);
});

test('stop on an unowned agent carries the E_NOT_MANAGED token', async (t) => {
  t.mock.module('../dist/hcom.js', { namedExports: hcomMock() });
  t.mock.module('../dist/registry.js', { namedExports: registryMock() });

  const { registerLifecycleTools } = await loadModule('tools/lifecycle.js');
  const server = createFakeServer();
  registerLifecycleTools(server);

  const response = await server.handlers.get('stop')({ names: ['waka'], workspace: '/repo', sender_name: 'nora' });
  assert.equal(response.isError, true);
  assert.match(response.content[0].text, /^\[E_NOT_MANAGED\]/);
});

test('kill of the calling hub agent carries the E_SELF_PROTECTION token', async (t) => {
  t.mock.module('../dist/hcom.js', { namedExports: hcomMock() });
  t.mock.module('../dist/registry.js', {
    namedExports: registryMock({
      getOwnedRecordsByWorkspace: () => [
        { id: 'rec-1', workspace: '/repo', hcomName: 'nora', state: 'managed_active' },
      ],
    }),
  });

  const { registerLifecycleTools } = await loadModule('tools/lifecycle.js');
  const server = createFakeServer();
  registerLifecycleTools(server);

  const response = await server.handlers.get('kill')({ names: ['nora'], workspace: '/repo', sender_name: 'nora' });
  assert.equal(response.isError, true);
  assert.match(response.content[0].text, /^\[E_SELF_PROTECTION\]/);
});

test('stop without names or tag carries the E_TARGET_REQUIRED token', async (t) => {
  t.mock.module('../dist/hcom.js', { namedExports: hcomMock() });
  t.mock.module('../dist/registry.js', { namedExports: registryMock() });

  const { registerLifecycleTools } = await loadModule('tools/lifecycle.js');
  const server = createFakeServer();
  registerLifecycleTools(server);

  const response = await server.handlers.get('stop')({ workspace: '/repo', sender_name: 'nora' });
  assert.equal(response.isError, true);
  assert.match(response.content[0].text, /^\[E_TARGET_REQUIRED\]/);
});

test('inspect on a missing agent carries the E_AGENT_NOT_FOUND token', async (t) => {
  t.mock.module('../dist/hcom.js', {
    namedExports: hcomMock({ findLiveAgentByIdentifier: () => null }),
  });
  t.mock.module('../dist/registry.js', { namedExports: registryMock() });

  const { registerInspectTool } = await loadModule('tools/inspect.js');
  const server = createFakeServer();
  registerInspectTool(server);

  const response = await server.handlers.get('inspect')({ name: 'ghost', aspect: 'status' });
  assert.equal(response.isError, true);
  assert.match(response.content[0].text, /^\[E_AGENT_NOT_FOUND\]/);
});

test('transcript read without a name carries the E_NAME_REQUIRED token', async () => {
  const { registerTranscriptTool } = await loadModule('tools/transcript.js');
  const server = createFakeServer();
  registerTranscriptTool(server);

  const response = await server.handlers.get('transcript')({ mode: 'read' });
  assert.equal(response.isError, true);
  assert.match(response.content[0].text, /^\[E_NAME_REQUIRED\]/);
});

test('transcript search without a pattern carries the E_PATTERN_REQUIRED token', async () => {
  const { registerTranscriptTool } = await loadModule('tools/transcript.js');
  const server = createFakeServer();
  registerTranscriptTool(server);

  const response = await server.handlers.get('transcript')({ mode: 'search' });
  assert.equal(response.isError, true);
  assert.match(response.content[0].text, /^\[E_PATTERN_REQUIRED\]/);
});

test('unblock on a non-blocked agent carries the E_AGENT_NOT_BLOCKED token', async (t) => {
  t.mock.module('../dist/hcom.js', { namedExports: hcomMock() });
  t.mock.module('../dist/registry.js', {
    namedExports: registryMock({
      getOwnedRecordsByWorkspace: () => [
        { id: 'rec-1', workspace: '/repo', hcomName: 'waka', state: 'managed_active' },
      ],
    }),
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
  assert.match(response.content[0].text, /\[E_AGENT_NOT_BLOCKED\]/);
});

test('adopt of a missing agent reports E_AGENT_NOT_FOUND in skipped', async (t) => {
  t.mock.module('../dist/hcom.js', { namedExports: hcomMock() });
  t.mock.module('../dist/registry.js', { namedExports: registryMock() });

  const { registerAdoptTool } = await loadModule('tools/adopt.js');
  const server = createFakeServer();
  registerAdoptTool(server);

  const response = await server.handlers.get('adopt')({
    names: ['ghost'],
    workspace: '/repo',
    sender_name: 'nora',
  });
  assert.equal(response.isError, true);
  assert.match(response.content[0].text, /\[E_AGENT_NOT_FOUND\]/);
});

test('unexpected exceptions surface as E_INTERNAL', async (t) => {
  t.mock.module('../dist/hcom.js', {
    namedExports: hcomMock({
      listHcomAgents: async () => {
        throw new Error('boom');
      },
    }),
  });
  t.mock.module('../dist/registry.js', { namedExports: registryMock() });

  const { registerListAllTool } = await loadModule('tools/list.js');
  const server = createFakeServer();
  registerListAllTool(server);

  const response = await server.handlers.get('list_all')({});
  assert.equal(response.isError, true);
  assert.match(response.content[0].text, /^\[E_INTERNAL\]/);
  assert.match(response.content[0].text, /boom/);
});

// --- thread_seed hub_name default + camelCase returned JSON ---

test('thread_seed defaults hub_name to sender_name and returns camelCase keys', async (t) => {
  let capturedArgs;

  t.mock.module('../dist/hcom.js', {
    namedExports: hcomMock({
      execHcom: async (args) => {
        capturedArgs = args;
        return { exitCode: 0, stdout: 'ok', stderr: '' };
      },
    }),
  });

  const { registerThreadSeedTool } = await loadModule('tools/threads.js');
  const server = createFakeServer();
  registerThreadSeedTool(server);

  const response = await server.handlers.get('thread_seed')({
    thread_name: 'wf-6',
    mentions: ['@eng-'],
    message: 'seed',
    sender_name: 'nora',
  });

  assert.ok(!response.isError, response?.content?.[0]?.text);
  assert.deepEqual(capturedArgs.slice(0, 6), ['send', '@nora', '@eng-', '--name', 'nora', '--thread']);
  const payload = JSON.parse(response.content[0].text);
  assert.equal(payload.threadName, 'wf-6');
  assert.equal(payload.senderName, 'nora');
  assert.equal(payload.hubName, 'nora');
  assert.equal(payload.seedDelivered, true);
  assert.equal(payload.thread_name, undefined);
  assert.equal(payload.sender_name, undefined);
  assert.equal(payload.seed_delivered, undefined);
});

test('thread_inspect returns camelCase keys', async (t) => {
  let capturedArgs;

  t.mock.module('../dist/hcom.js', {
    namedExports: hcomMock({
      execHcom: async (args) => {
        capturedArgs = args;
        return { exitCode: 0, stdout: '{"action":"message"}\n{"action":"status"}\n', stderr: '' };
      },
    }),
  });

  const { registerThreadInspectTool } = await loadModule('tools/threads.js');
  const server = createFakeServer();
  registerThreadInspectTool(server);

  const response = await server.handlers.get('thread_inspect')({ thread_name: 'wf-6' });

  assert.ok(!response.isError, response?.content?.[0]?.text);
  assert.deepEqual(capturedArgs, ['events', '--thread', 'wf-6', '--last', '20']);
  const payload = JSON.parse(response.content[0].text);
  assert.equal(payload.threadName, 'wf-6');
  assert.equal(payload.eventCount, 2);
  assert.equal(payload.events.length, 2);
  assert.equal(payload.thread_name, undefined);
  assert.equal(payload.event_count, undefined);
});

// --- prune all_workspaces canonical param ---

test('prune forwards all_workspaces and keeps the camelCase alias deprecated', async (t) => {
  const received = [];
  t.mock.module('../dist/hcom.js', { namedExports: hcomMock() });
  t.mock.module('../dist/registry.js', {
    namedExports: registryMock({
      pruneRecords: async (workspace, options) => {
        received.push(options);
        return { removed: [], wouldRemove: [] };
      },
    }),
  });

  const { registerPruneTool } = await loadModule('tools/prune.js');
  const server = createFakeServer();
  registerPruneTool(server);

  // Canonical snake_case name.
  await server.handlers.get('prune')({ workspace: '/repo', all_workspaces: true });
  assert.equal(received[0].allWorkspaces, true);

  // Deprecated camelCase alias still works for one release.
  await server.handlers.get('prune')({ workspace: '/repo', allWorkspaces: true });
  assert.equal(received[1].allWorkspaces, true);

  // Default stays scoped.
  await server.handlers.get('prune')({ workspace: '/repo' });
  assert.equal(received[2].allWorkspaces, false);
});

// --- launch count ---

test('launch count spawns N agents in one hcom call with a [N] prefix', async (t) => {
  const launchedArgs = [];
  const addedRecords = [];

  t.mock.module('../dist/hcom.js', {
    namedExports: hcomMock({
      execHcom: async (args) => {
        if (args[0] === 'events' && args[1] === 'sub') {
          return { exitCode: 0, stdout: 'Subscription sub-abc123 created', stderr: '' };
        }
        launchedArgs.push(args);
        return {
          exitCode: 0,
          stdout: 'Names: waka zago\nBatch id: batch-1\n',
          stderr: '',
        };
      },
      listHarnessModels: async (harness) => {
        const models = { claude: ['haiku'] };
        const available = models[harness] || [];
        return [{ harness, status: 'live', source: 'mock', models: available, count: available.length }];
      },
    }),
  });
  t.mock.module('../dist/registry.js', {
    namedExports: registryMock({
      addRecord: (record) => {
        addedRecords.push(record);
        return { ...record, id: `record-${addedRecords.length}` };
      },
    }),
  });

  const { registerLaunchTool } = await loadModule('tools/launch.js');
  const server = createFakeServer();
  registerLaunchTool(server);

  const response = await server.handlers.get('launch')({
    harness: 'claude',
    model: 'haiku',
    count: 2,
    sender_name: 'nora',
  });

  assert.ok(!response.isError, response?.content?.[0]?.text);
  assert.equal(launchedArgs.length, 1);
  assert.equal(launchedArgs[0][0], '2');
  assert.equal(launchedArgs[0][1], 'claude');
  assert.equal(addedRecords.length, 2);
  const payload = JSON.parse(response.content[0].text);
  assert.deepEqual(payload.hcomNames, ['waka', 'zago']);
  assert.equal(payload.registryIds.length, 2);
});

test('launch without count does not add a [N] prefix', async (t) => {
  const launchedArgs = [];

  t.mock.module('../dist/hcom.js', {
    namedExports: hcomMock({
      execHcom: async (args) => {
        if (args[0] === 'events' && args[1] === 'sub') {
          return { exitCode: 0, stdout: 'Subscription sub-abc123 created', stderr: '' };
        }
        launchedArgs.push(args);
        return { exitCode: 0, stdout: 'Names: waka\nBatch id: batch-1\n', stderr: '' };
      },
      listHarnessModels: async (harness) => {
        const models = { claude: ['haiku'] };
        const available = models[harness] || [];
        return [{ harness, status: 'live', source: 'mock', models: available, count: available.length }];
      },
    }),
  });
  t.mock.module('../dist/registry.js', { namedExports: registryMock() });

  const { registerLaunchTool } = await loadModule('tools/launch.js');
  const server = createFakeServer();
  registerLaunchTool(server);

  const response = await server.handlers.get('launch')({
    harness: 'claude',
    model: 'haiku',
    sender_name: 'nora',
  });

  assert.ok(!response.isError, response?.content?.[0]?.text);
  assert.equal(launchedArgs[0][0], 'claude');
});

// --- continue_from --compact ---

test('continue_from passes --compact through to hcom bundle prepare', async (t) => {
  let capturedArgs;

  t.mock.module('../dist/hcom.js', {
    namedExports: hcomMock({
      execHcom: async (args) => {
        capturedArgs = args;
        return { exitCode: 0, stdout: JSON.stringify({ note: 'bundle' }), stderr: '' };
      },
    }),
  });

  const { registerContinueFromTool } = await loadModule('tools/continue_from.js');
  const server = createFakeServer();
  registerContinueFromTool(server);

  const response = await server.handlers.get('continue_from')({
    name: 'mosa',
    compact: true,
  });

  assert.ok(!response.isError, response?.content?.[0]?.text);
  const compactIndex = capturedArgs.indexOf('--compact');
  assert.ok(compactIndex > 0);
  assert.equal(capturedArgs[compactIndex + 1], '--json');
});

// --- transcript omp enum ---

test('transcript search accepts agent_type omp', async (t) => {
  let capturedArgs;

  t.mock.module('../dist/hcom.js', {
    namedExports: hcomMock({
      execHcom: async (args) => {
        capturedArgs = args;
        return { exitCode: 0, stdout: JSON.stringify({ results: [] }), stderr: '' };
      },
    }),
  });

  const { registerTranscriptTool } = await loadModule('tools/transcript.js');
  const server = createFakeServer();
  registerTranscriptTool(server);

  const response = await server.handlers.get('transcript')({
    mode: 'search',
    pattern: 'foo',
    agent_type: 'omp',
  });

  assert.ok(!response.isError, response?.content?.[0]?.text);
  const agentIndex = capturedArgs.indexOf('--agent');
  assert.equal(capturedArgs[agentIndex + 1], 'omp');
});

// --- list_presets prompt_preview ---

test('list_presets includes promptPreview only when prompt_preview=true', async (t) => {
  t.mock.module('../dist/config.js', {
    namedExports: {
      getConfigPaths: () => ({ globalConfig: {}, workspaceConfig: {}, registry: {} }),
      loadMergedConfig: () => ({
        agentPresets: {
          researcher: {
            name: 'researcher',
            harness: { claude: { model: 'haiku' } },
            headless: true,
            pty: false,
            prompt: 'You are a researcher. ' + 'x'.repeat(200),
          },
        },
        topologyPresets: {},
      }),
      summarizeAgentPresets,
      summarizeTopologyPresets: () => [],
    },
  });
  t.mock.module('../dist/registry.js', { namedExports: registryMock() });

  const { registerListPresetsTool } = await loadModule('tools/list.js');
  const server = createFakeServer();
  registerListPresetsTool(server);

  const withPreview = await server.handlers.get('list_presets')({ prompt_preview: true });
  assert.ok(!withPreview.isError, withPreview?.content?.[0]?.text);
  const previewPayload = JSON.parse(withPreview.content[0].text);
  assert.equal(previewPayload.presets[0].promptPreview.length, 120);

  const withoutPreview = await server.handlers.get('list_presets')({});
  assert.ok(!withoutPreview.isError, withoutPreview?.content?.[0]?.text);
  const plainPayload = JSON.parse(withoutPreview.content[0].text);
  assert.equal(plainPayload.presets[0].promptPreview, undefined);
});

// --- adopt bulk + notice override ---

test('adopt accepts multiple names, skips failures, and honors a custom notice', async (t) => {
  const sendArgs = [];
  const adopted = [];

  t.mock.module('../dist/hcom.js', {
    namedExports: hcomMock({
      execHcom: async (args) => {
        sendArgs.push(args);
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    }),
  });
  t.mock.module('../dist/registry.js', {
    namedExports: registryMock({
      adoptRecord: (params) => {
        adopted.push(params);
        return { ...params, id: `adopted-${adopted.length}` };
      },
    }),
  });

  const { registerAdoptTool } = await loadModule('tools/adopt.js');
  const server = createFakeServer();
  registerAdoptTool(server);

  const response = await server.handlers.get('adopt')({
    names: ['waka', 'zago', 'ghost'],
    workspace: '/repo',
    sender_name: 'nora',
    notice: 'custom notice text',
  });

  assert.ok(!response.isError, response?.content?.[0]?.text);
  const payload = JSON.parse(response.content[0].text);
  assert.equal(payload.adopted.length, 2);
  assert.equal(payload.total, 2);
  assert.equal(payload.skipped.length, 1);
  assert.match(payload.skipped[0], /\[E_AGENT_NOT_FOUND\]/);
  assert.equal(adopted.length, 2);
  assert.equal(sendArgs.length, 2);
  // Custom notice is the last send argument.
  assert.equal(sendArgs[0][sendArgs[0].length - 1], 'custom notice text');
});

// --- codex reasoningNote ---

test('codex launch returns a reasoningNote and never passes reasoning flags', async (t) => {
  let capturedArgs;

  t.mock.module('../dist/hcom.js', {
    namedExports: hcomMock({
      execHcom: async (args) => {
        if (args[0] === 'events' && args[1] === 'sub') {
          return { exitCode: 0, stdout: 'Subscription sub-abc123 created', stderr: '' };
        }
        capturedArgs = args;
        return { exitCode: 0, stdout: 'Names: waka\nBatch id: batch-1\n', stderr: '' };
      },
      listHarnessModels: async (harness) => {
        const models = { codex: ['gpt-5.4'] };
        const available = models[harness] || [];
        return [{ harness, status: 'live', source: 'mock', models: available, count: available.length }];
      },
    }),
  });
  t.mock.module('../dist/registry.js', { namedExports: registryMock() });

  const { registerLaunchTool } = await loadModule('tools/launch.js');
  const server = createFakeServer();
  registerLaunchTool(server);

  const response = await server.handlers.get('launch')({
    harness: 'codex',
    model: 'gpt-5.4',
    reasoning: 'high',
    sender_name: 'nora',
  });

  assert.ok(!response.isError, response?.content?.[0]?.text);
  const payload = JSON.parse(response.content[0].text);
  assert.match(payload.reasoningNote, /ignored by the codex harness/);
  assert.equal(capturedArgs.includes('--variant'), false);
  assert.equal(capturedArgs.includes('--effort'), false);
});

// --- watch_agents returned JSON camelCase (LOW-1) ---

test('watch_agents poll returns camelCase keys and subscribe returns subId', async (t) => {
  const eventsCalls = [];

  t.mock.module('../dist/hcom.js', {
    namedExports: hcomMock({
      listHcomAgents: async () => [
        { name: 'blok', base_name: 'blok', status: 'blocked', status_age_seconds: 10, unread_count: 0, tag: null },
        { name: 'sile', base_name: 'sile', status: 'listening', status_age_seconds: 600, unread_count: 0, tag: null },
      ],
      execHcom: async (args) => {
        eventsCalls.push(args);
        if (args[0] === 'events' && args[1] === 'sub') {
          return { exitCode: 0, stdout: 'Subscription sub-abc123 created', stderr: '' };
        }
        if (args[0] === 'events' && args.includes('--type') && args.includes('life')) {
          return { exitCode: 0, stdout: '{"action":"ready"}\n', stderr: '' };
        }
        if (args[0] === 'events' && args.includes('--type') && args.includes('message')) {
          if (args[args.length - 1] === 'sile') {
            return { exitCode: 0, stdout: '{"from":"sile","text":"done"}\n', stderr: '' };
          }
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        throw new Error(`unexpected args: ${args.join(' ')}`);
      },
    }),
  });
  t.mock.module('../dist/registry.js', {
    namedExports: registryMock({
      getOwnedRecordsByWorkspace: () => [
        { id: 'r1', workspace: '/repo', hcomName: 'blok', state: 'managed_active' },
        { id: 'r2', workspace: '/repo', hcomName: 'sile', state: 'managed_active' },
      ],
    }),
  });

  const { registerWatchAgentsTool } = await loadModule('tools/watch.js');
  const server = createFakeServer();
  registerWatchAgentsTool(server);

  const poll = await server.handlers.get('watch_agents')({ workspace: '/repo' });
  assert.ok(!poll.isError, poll?.content?.[0]?.text);
  const pollPayload = JSON.parse(poll.content[0].text);
  const byName = Object.fromEntries(pollPayload.agents.map((a) => [a.name, a]));
  assert.equal(byName.blok.statusAgeSeconds, 10);
  assert.equal(byName.sile.lastLifeEvent, 'ready');
  assert.match(byName.sile.lastMessage, /^sile: done$/);
  assert.equal(byName.blok.status_age_seconds, undefined);
  assert.equal(byName.blok.unread_count, undefined);
  assert.equal(byName.blok.last_life_event, undefined);
  assert.equal(byName.blok.last_message, undefined);

  const sub = await server.handlers.get('watch_agents')({
    workspace: '/repo',
    mode: 'subscribe',
    sender_name: 'nora',
  });
  assert.ok(!sub.isError, sub?.content?.[0]?.text);
  const subPayload = JSON.parse(sub.content[0].text);
  assert.equal(subPayload.subscriptions[0].subId, 'sub-abc123');
  assert.equal(subPayload.subscriptions[0].sub_id, undefined);
});

// --- antigravity skips model validation ---

test('validatePresetModelAvailability skips antigravity without touching the catalog', async (t) => {
  let catalogCalls = 0;
  t.mock.module('../dist/hcom.js', {
    namedExports: hcomMock({
      listHarnessModels: async () => {
        catalogCalls += 1;
        throw new Error('catalog should not be consulted for antigravity');
      },
    }),
  });

  const { validatePresetModelAvailability } = await loadModule('tools/launch.js');
  const error = await validatePresetModelAvailability({
    name: 'adhoc',
    harness: 'antigravity',
    model: 'anything',
  });
  assert.equal(error, null);
  assert.equal(catalogCalls, 0);
});

test('antigravity launch never passes --model', async (t) => {
  let capturedArgs;

  t.mock.module('../dist/hcom.js', {
    namedExports: hcomMock({
      execHcom: async (args) => {
        if (args[0] === 'events' && args[1] === 'sub') {
          return { exitCode: 0, stdout: 'Subscription sub-abc123 created', stderr: '' };
        }
        capturedArgs = args;
        return { exitCode: 0, stdout: 'Names: waka\nBatch id: batch-1\n', stderr: '' };
      },
      listHarnessModels: async () => {
        throw new Error('catalog should not be consulted for antigravity');
      },
    }),
  });
  t.mock.module('../dist/registry.js', { namedExports: registryMock() });

  const { registerLaunchTool } = await loadModule('tools/launch.js');
  const server = createFakeServer();
  registerLaunchTool(server);

  const response = await server.handlers.get('launch')({
    harness: 'antigravity',
    model: 'anything',
    sender_name: 'nora',
  });

  assert.ok(!response.isError, response?.content?.[0]?.text);
  assert.equal(capturedArgs.includes('--model'), false);
  assert.equal(capturedArgs[0], 'agy');
});
