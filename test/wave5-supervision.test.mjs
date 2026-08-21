import test from 'node:test';
import assert from 'node:assert/strict';

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

function baseRecord(overrides = {}) {
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

// --- #7: watch_agents poll mode ---

function mockWatchDeps(t, { records, liveAgents, execHcom }) {
  t.mock.module('../dist/hcom.js', {
    namedExports: {
      listHcomAgents: async () => liveAgents,
      findLiveAgentByIdentifier: (id, agents) =>
        agents.find((a) => a.name === id || a.base_name === id) ?? null,
      canonicalizeAgentName: (id, agents) =>
        agents.find((a) => a.name === id || a.base_name === id)?.base_name ??
        (id.startsWith('@') ? id.slice(1) : id),
      parseHcomJson: JSON.parse,
      resolveCallerName: async (override) => override,
      execHcom: execHcom,
    },
  });
  t.mock.module('../dist/registry.js', {
    namedExports: {
      getOwnedRecordsByWorkspace: () => records,
      resolveRootLauncher: (record) => record.launchedBy,
    },
  });
}

test('watch_agents poll derives blocked, silent_finisher, stalled, lost, unreported flags', async (t) => {
  const eventsCalls = [];
  mockWatchDeps(t, {
    records: [
      baseRecord({ id: 'r1', hcomName: 'blok' }),
      baseRecord({ id: 'r2', hcomName: 'sile' }),
      baseRecord({ id: 'r3', hcomName: 'stal' }),
      baseRecord({ id: 'r4', hcomName: 'gone' }),
      baseRecord({ id: 'r5', hcomName: 'unre' }),
      baseRecord({ id: 'r6', hcomName: 'fine' }),
    ],
    liveAgents: [
      { name: 'blok', base_name: 'blok', status: 'blocked', status_age_seconds: 10, unread_count: 0, tag: null },
      { name: 'sile', base_name: 'sile', status: 'listening', status_age_seconds: 600, unread_count: 0, tag: null },
      { name: 'stal', base_name: 'stal', status: 'active', status_age_seconds: 900, unread_count: 0, tag: null },
      { name: 'unre', base_name: 'unre', status: 'listening', status_age_seconds: 5, unread_count: 3, tag: null },
      { name: 'fine', base_name: 'fine', status: 'listening', status_age_seconds: 5, unread_count: 0, tag: null },
    ],
    execHcom: async (args) => {
      eventsCalls.push(args);
      if (args[0] === 'events' && args.includes('--type') && args.includes('life')) {
        return { exitCode: 0, stdout: '{"action":"ready"}\n', stderr: '' };
      }
      if (args[0] === 'events' && args.includes('--type') && args.includes('status')) {
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'events' && args.includes('--type') && args.includes('message')) {
        // sile has a last report (silent finisher); fine has none (plain idle).
        if (args[args.length - 1] === 'sile') {
          return { exitCode: 0, stdout: '{"from":"sile","text":"done"}\n', stderr: '' };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      throw new Error(`unexpected args: ${args.join(' ')}`);
    },
  });

  const { registerWatchAgentsTool } = await loadModule('tools/watch.js');
  const server = createFakeServer();
  registerWatchAgentsTool(server);

  const response = await server.handlers.get('watch_agents')({
    workspace: '/repo',
    report_timeout_sec: 300,
  });

  assert.equal(response.isError, undefined);
  const payload = JSON.parse(response.content[0].text);
  assert.equal(payload.mode, 'poll');

  const byName = Object.fromEntries(payload.agents.map((a) => [a.name, a]));
  assert.deepEqual(byName.blok.flags, ['blocked']);
  assert.deepEqual(byName.sile.flags, ['silent_finisher']);
  assert.deepEqual(byName.stal.flags, ['stalled']);
  assert.deepEqual(byName.gone.flags, ['lost']);
  assert.deepEqual(byName.unre.flags, ['unreported']);
  assert.deepEqual(byName.fine.flags, []);

  // Wave 6: returned payload obeys the camelCase contract.
  assert.equal(byName.blok.statusAgeSeconds, 10);
  assert.equal(byName.unre.unreadCount, 3);
  assert.equal(byName.sile.lastLifeEvent, 'ready');
  assert.match(byName.sile.lastMessage, /^sile: done$/);
  assert.equal(byName.blok.status_age_seconds, undefined);
  assert.equal(byName.blok.unread_count, undefined);
  assert.equal(byName.blok.last_life_event, undefined);
  assert.equal(byName.blok.last_message, undefined);

  assert.equal(payload.summary.blocked, 1);
  assert.equal(payload.summary.silent_finisher, 1);
  assert.equal(payload.summary.stalled, 1);
  assert.equal(payload.summary.lost, 1);
  assert.equal(payload.summary.unreported, 1);
  assert.equal(payload.summary.healthy, 1);
});

test('watch_agents poll scopes by tag over owned records only', async (t) => {
  mockWatchDeps(t, {
    records: [
      baseRecord({ id: 'r1', hcomName: 'waka' }),
      baseRecord({ id: 'r2', hcomName: 'zago' }),
    ],
    liveAgents: [
      { name: 'team-waka', base_name: 'waka', status: 'listening', status_age_seconds: 5, unread_count: 0, tag: 'team' },
      { name: 'zago', base_name: 'zago', status: 'listening', status_age_seconds: 5, unread_count: 0, tag: 'other' },
    ],
    execHcom: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
  });

  const { registerWatchAgentsTool } = await loadModule('tools/watch.js');
  const server = createFakeServer();
  registerWatchAgentsTool(server);

  const response = await server.handlers.get('watch_agents')({
    workspace: '/repo',
    tag: 'team',
  });

  const payload = JSON.parse(response.content[0].text);
  assert.equal(payload.agents.length, 1);
  assert.equal(payload.agents[0].name, 'team-waka');
});

test('watch_agents subscribe hard-errors for unbound callers without sender_name', async (t) => {
  mockWatchDeps(t, {
    records: [baseRecord()],
    liveAgents: [],
    execHcom: async () => {
      throw new Error('execHcom should not be called when sender identity is missing');
    },
  });

  const { registerWatchAgentsTool } = await loadModule('tools/watch.js');
  const server = createFakeServer();
  registerWatchAgentsTool(server);

  const response = await server.handlers.get('watch_agents')({
    workspace: '/repo',
    mode: 'subscribe',
  });

  assert.equal(response.isError, true);
  assert.match(response.content[0].text, /sender_name/i);
});

test('watch_agents subscribe installs life and blocked subs for the caller', async (t) => {
  const subCalls = [];
  mockWatchDeps(t, {
    records: [baseRecord({ hcomName: 'waka' })],
    liveAgents: [],
    execHcom: async (args) => {
      subCalls.push(args);
      return { exitCode: 0, stdout: 'Subscription sub-abc123 created', stderr: '' };
    },
  });

  const { registerWatchAgentsTool } = await loadModule('tools/watch.js');
  const server = createFakeServer();
  registerWatchAgentsTool(server);

  const response = await server.handlers.get('watch_agents')({
    workspace: '/repo',
    mode: 'subscribe',
    sender_name: 'nora',
  });

  assert.equal(response.isError, undefined);
  const payload = JSON.parse(response.content[0].text);
  assert.equal(payload.mode, 'subscribe');
  assert.equal(payload.caller, 'nora');
  assert.equal(payload.subscriptions.length, 2);
  assert.equal(payload.subscriptions[0].kind, 'life');
  assert.equal(payload.subscriptions[1].kind, 'blocked');
  assert.equal(payload.subscriptions[0].subId, 'sub-abc123');
  assert.equal(payload.subscriptions[0].sub_id, undefined);

  // Both subs are installed on behalf of the caller.
  assert.ok(subCalls.every((args) => args.includes('--for') && args.includes('nora')));
  assert.ok(subCalls.some((args) => args.includes('--type') && args.includes('life')));
  assert.ok(subCalls.some((args) => args.includes('--status') && args.includes('blocked')));
});

// --- #16: claude model pass-through ---

test('validatePresetModelAvailability passes through claude full model IDs', async (t) => {
  const { validatePresetModelAvailability } = await loadModule('tools/launch.js');
  const error = await validatePresetModelAvailability({
    name: 'builder',
    harness: 'claude',
    model: 'claude-opus-4-8',
  });
  assert.equal(error, null);
});

test('validatePresetModelAvailability passes through dated claude variants with -1m suffix', async (t) => {
  const { validatePresetModelAvailability } = await loadModule('tools/launch.js');
  const error = await validatePresetModelAvailability({
    name: 'builder',
    harness: 'claude',
    model: 'claude-sonnet-4-5-1m',
  });
  assert.equal(error, null);
});

test('validatePresetModelAvailability still hard-rejects non-claude strings for claude', async (t) => {
  const { validatePresetModelAvailability } = await loadModule('tools/launch.js');
  const error = await validatePresetModelAvailability({
    name: 'builder',
    harness: 'claude',
    model: 'gpt-5.5',
  });
  assert.match(error, /not found/i);
});

test('launch result carries modelNote for pass-through claude models', async (t) => {
  const launchedArgs = [];
  t.mock.module('../dist/hcom.js', {
    namedExports: {
      resolveCallerName: async (override) => override,
      execHcom: async (args) => {
        launchedArgs.push(args);
        return { exitCode: 0, stdout: 'Names: test-agent\nBatch id: batch-123\n', stderr: '' };
      },
      listHarnessModels: async (harness) => {
        const models = { claude: ['sonnet', 'haiku', 'opus'] };
        const available = models[harness] || [];
        return [{ harness, status: 'bundled', source: 'mock', models: available, count: available.length }];
      },
    },
  });
  t.mock.module('../dist/registry.js', {
    namedExports: {
      addRecord: (record) => ({ ...record, id: 'rec-1' }),
      removeRecords: () => {},
      updateRecordState: () => null,
      updateRecordVerify: () => null,
    },
  });

  const { registerLaunchTool } = await loadModule('tools/launch.js');
  const server = createFakeServer();
  registerLaunchTool(server);

  const response = await server.handlers.get('launch')({
    harness: 'claude',
    model: 'claude-opus-4-8',
    sender_name: 'nora',
  });

  assert.equal(response.isError, undefined);
  const payload = JSON.parse(response.content[0].text);
  assert.match(payload.modelNote, /unverified/i);
  assert.ok(launchedArgs[0].includes('--model'));
  assert.ok(launchedArgs[0].includes('claude-opus-4-8'));
});

test('launch result has no modelNote for bundled claude aliases', async (t) => {
  t.mock.module('../dist/hcom.js', {
    namedExports: {
      resolveCallerName: async (override) => override,
      execHcom: async () => ({ exitCode: 0, stdout: 'Names: test-agent\nBatch id: batch-123\n', stderr: '' }),
      listHarnessModels: async (harness) => {
        const models = { claude: ['sonnet', 'haiku', 'opus'] };
        const available = models[harness] || [];
        return [{ harness, status: 'bundled', source: 'mock', models: available, count: available.length }];
      },
    },
  });
  t.mock.module('../dist/registry.js', {
    namedExports: {
      addRecord: (record) => ({ ...record, id: 'rec-1' }),
      removeRecords: () => {},
      updateRecordState: () => null,
      updateRecordVerify: () => null,
    },
  });

  const { registerLaunchTool } = await loadModule('tools/launch.js');
  const server = createFakeServer();
  registerLaunchTool(server);

  const response = await server.handlers.get('launch')({
    harness: 'claude',
    model: 'sonnet',
    sender_name: 'nora',
  });

  const payload = JSON.parse(response.content[0].text);
  assert.equal(payload.modelNote, undefined);
});

// --- #11.2: tag/names teardown ---

function mockLifecycleDeps(t, { records, liveAgents, execHcom }) {
  t.mock.module('../dist/hcom.js', {
    namedExports: {
      resolveCallerName: async (override) => override,
      listHcomAgents: async () => liveAgents,
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

test('kill with tag fans out over owned records only', async (t) => {
  const calls = [];
  mockLifecycleDeps(t, {
    records: [
      baseRecord({ id: 'r1', hcomName: 'waka' }),
      baseRecord({ id: 'r2', hcomName: 'zago' }),
    ],
    liveAgents: [
      { name: 'team-waka', base_name: 'waka', status: 'listening', tag: 'team' },
      { name: 'zago', base_name: 'zago', status: 'listening', tag: 'other' },
    ],
    execHcom: async (args) => {
      calls.push(args);
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  });

  const { registerLifecycleTools } = await loadModule('tools/lifecycle.js');
  const server = createFakeServer();
  registerLifecycleTools(server);

  const response = await server.handlers.get('kill')({
    tag: 'team',
    workspace: '/repo',
    sender_name: 'nora',
  });

  assert.equal(response.isError, undefined);
  const payload = JSON.parse(response.content[0].text);
  assert.equal(payload.killed, 1);
  assert.equal(payload.failed, 0);
  assert.deepEqual(calls, [['kill', 'waka', '--go']]);
});

test('kill with names returns per-name results and skips unowned targets', async (t) => {
  const calls = [];
  mockLifecycleDeps(t, {
    records: [baseRecord({ id: 'r1', hcomName: 'waka' })],
    liveAgents: [
      { name: 'waka', base_name: 'waka', status: 'listening', tag: null },
      { name: 'zago', base_name: 'zago', status: 'listening', tag: null },
    ],
    execHcom: async (args) => {
      calls.push(args);
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  });

  const { registerLifecycleTools } = await loadModule('tools/lifecycle.js');
  const server = createFakeServer();
  registerLifecycleTools(server);

  const response = await server.handlers.get('kill')({
    names: ['waka', 'zago'],
    workspace: '/repo',
    sender_name: 'nora',
  });

  const payload = JSON.parse(response.content[0].text);
  assert.equal(payload.killed, 1);
  assert.equal(payload.failed, 0);
  assert.equal(payload.skipped.length, 1);
  assert.match(payload.skipped[0], /not managed/i);
  assert.deepEqual(calls, [['kill', 'waka', '--go']]);
});

test('stop with names reports per-name failures when the CLI fails', async (t) => {
  mockLifecycleDeps(t, {
    records: [baseRecord({ id: 'r1', hcomName: 'waka' })],
    liveAgents: [{ name: 'waka', base_name: 'waka', status: 'listening', tag: null }],
    execHcom: async () => ({ exitCode: 1, stdout: '', stderr: 'boom' }),
  });

  const { registerLifecycleTools } = await loadModule('tools/lifecycle.js');
  const server = createFakeServer();
  registerLifecycleTools(server);

  const response = await server.handlers.get('stop')({
    names: ['waka'],
    workspace: '/repo',
    sender_name: 'nora',
  });

  assert.equal(response.isError, true);
  const payload = JSON.parse(response.content[0].text);
  assert.equal(payload.stopped, 0);
  assert.equal(payload.failed, 1);
  assert.match(payload.results[0].text, /boom/);
});

test('tag teardown still refuses the calling hub agent', async (t) => {
  mockLifecycleDeps(t, {
    records: [baseRecord({ id: 'r1', hcomName: 'vade' })],
    liveAgents: [{ name: 'w3-vade', base_name: 'vade', status: 'listening', tag: 'w3' }],
    execHcom: async () => {
      throw new Error('execHcom should not be called for hub self-protection');
    },
  });

  const { registerLifecycleTools } = await loadModule('tools/lifecycle.js');
  const server = createFakeServer();
  registerLifecycleTools(server);

  const response = await server.handlers.get('kill')({
    names: ['w3-vade'],
    workspace: '/repo',
    sender_name: 'w3-vade',
  });

  assert.equal(response.isError, true);
  assert.match(response.content[0].text, /calling hub agent/i);
});

test('tag fanout excludes the calling hub agent from the group', async (t) => {
  const calls = [];
  mockLifecycleDeps(t, {
    records: [
      baseRecord({ id: 'r1', hcomName: 'vade' }),
      baseRecord({ id: 'r2', hcomName: 'waka' }),
    ],
    liveAgents: [
      { name: 'w3-vade', base_name: 'vade', status: 'listening', tag: 'w3' },
      { name: 'w3-waka', base_name: 'waka', status: 'listening', tag: 'w3' },
    ],
    execHcom: async (args) => {
      calls.push(args);
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  });

  const { registerLifecycleTools } = await loadModule('tools/lifecycle.js');
  const server = createFakeServer();
  registerLifecycleTools(server);

  const response = await server.handlers.get('kill')({
    tag: 'w3',
    workspace: '/repo',
    sender_name: 'w3-vade',
  });

  assert.equal(response.isError, undefined);
  const payload = JSON.parse(response.content[0].text);
  assert.equal(payload.killed, 1);
  // The hub's own agent is never in the fanout.
  assert.deepEqual(calls, [['kill', 'waka', '--go']]);
});

test('stop/kill require names or tag', async (t) => {
  mockLifecycleDeps(t, {
    records: [],
    liveAgents: [],
    execHcom: async () => {
      throw new Error('execHcom should not be called without targets');
    },
  });

  const { registerLifecycleTools } = await loadModule('tools/lifecycle.js');
  const server = createFakeServer();
  registerLifecycleTools(server);

  const response = await server.handlers.get('kill')({
    workspace: '/repo',
    sender_name: 'nora',
  });

  assert.equal(response.isError, true);
  assert.match(response.content[0].text, /name or a tag/i);
});

// --- #11.4: resume/fork ---

function mockResumeForkDeps(t, { execHcom }) {
  t.mock.module('../dist/hcom.js', {
    namedExports: {
      resolveCallerName: async (override) => override,
      execHcom: execHcom,
      execCommand: async () => ({ exitCode: 1, stdout: '', stderr: 'unexpected direct command' }),
    },
  });
  t.mock.module('../dist/registry.js', {
    namedExports: {
      getOwnedRecordsByWorkspace: () => [],
      upsertResumedRecord: () => ({ id: 'rec-new' }),
      addRecord: (record) => ({ ...record, id: 'rec-new' }),
    },
  });
}

test('resume registers a record with resumedFrom and runs hcom r', async (t) => {
  const calls = [];
  mockResumeForkDeps(t, {
    execHcom: async (args) => {
      calls.push(args);
      if (args[0] === 'events' && args[1] === '--last' && args[2] === '100') {
        return { exitCode: 0, stdout: JSON.stringify({ id: 11, ts: new Date().toISOString(), type: 'status', instance: 'waka', data: { status: 'active' } }), stderr: '' };
      }
      return { exitCode: 0, stdout: 'Names: waka\n', stderr: '' };
    },
  });

  const { registerResumeForkTools } = await loadModule('tools/resume_fork.js');
  const server = createFakeServer();
  registerResumeForkTools(server);

  const response = await server.handlers.get('resume')({
    name: 'ses_abc123',
    workspace: '/repo',
    sender_name: 'nora',
    tag: 'w5',
  });

  assert.equal(response.isError, undefined);
  const payload = JSON.parse(response.content[0].text);
  assert.equal(payload.kind, 'resume');
  assert.equal(payload.spawnedName, 'waka');
  assert.equal(payload.resumedFrom, 'ses_abc123');
  assert.equal(payload.registryId, 'rec-new');
  assert.deepEqual(calls[0].slice(0, 3), ['r', 'ses_abc123', '--tag']);
});

test('fork registers a record with resumedFrom and runs hcom f', async (t) => {
  const calls = [];
  mockResumeForkDeps(t, {
    execHcom: async (args) => {
      calls.push(args);
      return { exitCode: 0, stdout: 'Forked waka\nNames: waka\n', stderr: '' };
    },
  });

  const { registerResumeForkTools } = await loadModule('tools/resume_fork.js');
  const server = createFakeServer();
  registerResumeForkTools(server);

  const response = await server.handlers.get('fork')({
    name: 'waka',
    workspace: '/repo',
    sender_name: 'nora',
  });

  assert.equal(response.isError, undefined);
  const payload = JSON.parse(response.content[0].text);
  assert.equal(payload.kind, 'fork');
  assert.equal(payload.spawnedName, 'waka');
  assert.equal(payload.resumedFrom, 'waka');
  assert.equal(calls[0][0], 'f');
});

test('resume errors clearly when sender_name is missing', async (t) => {
  mockResumeForkDeps(t, {
    execHcom: async () => {
      throw new Error('execHcom should not be called when sender identity is missing');
    },
  });

  const { registerResumeForkTools } = await loadModule('tools/resume_fork.js');
  const server = createFakeServer();
  registerResumeForkTools(server);

  const response = await server.handlers.get('resume')({
    name: 'waka',
    workspace: '/repo',
  });

  assert.equal(response.isError, true);
  assert.match(response.content[0].text, /sender_name/i);
});

test('resume reports hcom failure without registering a record', async (t) => {
  let addCalls = 0;
  t.mock.module('../dist/hcom.js', {
    namedExports: {
      resolveCallerName: async (override) => override,
      execHcom: async () => ({ exitCode: 1, stdout: '', stderr: 'target not found' }),
      execCommand: async () => ({ exitCode: 1, stdout: '', stderr: 'unexpected direct command' }),
    },
  });
  t.mock.module('../dist/registry.js', {
    namedExports: {
      getOwnedRecordsByWorkspace: () => [],
      upsertResumedRecord: () => ({ id: 'rec-new' }),
      addRecord: () => {
        addCalls += 1;
        return { id: 'rec-new' };
      },
    },
  });

  const { registerResumeForkTools } = await loadModule('tools/resume_fork.js');
  const server = createFakeServer();
  registerResumeForkTools(server);

  const response = await server.handlers.get('resume')({
    name: 'ghost',
    workspace: '/repo',
    sender_name: 'nora',
  });

  assert.equal(response.isError, true);
  assert.match(response.content[0].text, /target not found/);
  assert.equal(addCalls, 0);
});

// --- #11.5: send ---

function mockSendDeps(t, { execHcom }) {
  t.mock.module('../dist/hcom.js', {
    namedExports: {
      resolveCallerName: async (override) => override,
      execHcom: execHcom,
    },
  });
}

test('send builds @-prefixed targets with intent and reply_to', async (t) => {
  let capturedArgs;
  mockSendDeps(t, {
    execHcom: async (args) => {
      capturedArgs = args;
      return { exitCode: 0, stdout: 'Sent to: waka', stderr: '' };
    },
  });

  const { registerSendTool } = await loadModule('tools/send.js');
  const server = createFakeServer();
  registerSendTool(server);

  const response = await server.handlers.get('send')({
    targets: ['waka', '@zago'],
    message: 'hello',
    intent: 'request',
    reply_to: '42',
    sender_name: 'nora',
  });

  assert.equal(response.isError, undefined);
  const payload = JSON.parse(response.content[0].text);
  assert.equal(payload.delivered, true);
  assert.deepEqual(payload.targets, ['@waka', '@zago']);
  assert.equal(capturedArgs[0], 'send');
  assert.ok(capturedArgs.includes('@waka'));
  assert.ok(capturedArgs.includes('@zago'));
  assert.ok(capturedArgs.includes('--intent'));
  assert.ok(capturedArgs.includes('request'));
  assert.ok(capturedArgs.includes('--reply-to'));
  assert.ok(capturedArgs.includes('42'));
  assert.ok(capturedArgs.includes('--name'));
  assert.ok(capturedArgs.includes('nora'));
  assert.ok(capturedArgs.includes('--'));
  assert.ok(capturedArgs.includes('hello'));
});

test('send requires reply_to for intent=ack', async (t) => {
  mockSendDeps(t, {
    execHcom: async () => {
      throw new Error('execHcom should not be called for a malformed ack');
    },
  });

  const { registerSendTool } = await loadModule('tools/send.js');
  const server = createFakeServer();
  registerSendTool(server);

  const response = await server.handlers.get('send')({
    targets: ['waka'],
    message: 'ok',
    intent: 'ack',
    sender_name: 'nora',
  });

  assert.equal(response.isError, true);
  assert.match(response.content[0].text, /reply_to/i);
});

test('send errors clearly when sender_name is missing', async (t) => {
  mockSendDeps(t, {
    execHcom: async () => {
      throw new Error('execHcom should not be called when sender identity is missing');
    },
  });

  const { registerSendTool } = await loadModule('tools/send.js');
  const server = createFakeServer();
  registerSendTool(server);

  const response = await server.handlers.get('send')({
    targets: ['waka'],
    message: 'hello',
  });

  assert.equal(response.isError, true);
  assert.match(response.content[0].text, /sender_name/i);
});

test('send reports delivery failure as an error', async (t) => {
  mockSendDeps(t, {
    execHcom: async () => ({ exitCode: 1, stdout: '', stderr: 'no such agent' }),
  });

  const { registerSendTool } = await loadModule('tools/send.js');
  const server = createFakeServer();
  registerSendTool(server);

  const response = await server.handlers.get('send')({
    targets: ['ghost'],
    message: 'hello',
    sender_name: 'nora',
  });

  assert.equal(response.isError, true);
  const payload = JSON.parse(response.content[0].text);
  assert.equal(payload.delivered, false);
  assert.match(payload.output, /no such agent/);
});

// --- #11.1: harness widening ---

test('list_models returns bundled catalogs for the new harnesses', async () => {
  const { listHarnessModels } = await import('../dist/hcom.js');
  const results = await listHarnessModels();

  const byHarness = Object.fromEntries(results.map((r) => [r.harness, r]));
  assert.equal(byHarness.gemini.models.includes('gemini-3.1-pro-preview'), true);
  assert.equal(byHarness.kilo.models.includes('kilo/kilo-auto/free'), true);
  assert.equal(byHarness.pi.models.includes('claude-3-5-sonnet'), true);
  assert.equal(byHarness.omp.models.includes('claude-3-5-sonnet'), true);
  assert.equal(byHarness.cursor.models.includes('sonnet-4'), true);
  assert.equal(byHarness.kimi.models.includes('kimi-k2.6'), true);
  assert.equal(byHarness.copilot.models.includes('claude-haiku-4.5'), true);
  // antigravity stays an empty catalog: no --model selection.
  assert.equal(byHarness.antigravity.models.length, 0);
});

test('HARNESS_COMMAND maps cursor to cursor-agent and the rest to their names', async () => {
  const { HARNESS_COMMAND, HARNESS_ENV_ARGS } = await import('../dist/types.js');
  assert.equal(HARNESS_COMMAND.cursor, 'cursor-agent');
  assert.equal(HARNESS_COMMAND.gemini, 'gemini');
  assert.equal(HARNESS_COMMAND.kilo, 'kilo');
  assert.equal(HARNESS_COMMAND.pi, 'pi');
  assert.equal(HARNESS_COMMAND.omp, 'omp');
  assert.equal(HARNESS_COMMAND.kimi, 'kimi');
  assert.equal(HARNESS_COMMAND.copilot, 'copilot');
  assert.equal(HARNESS_ENV_ARGS.gemini, 'HCOM_GEMINI_ARGS');
  assert.equal(HARNESS_ENV_ARGS.copilot, 'HCOM_COPILOT_ARGS');
});

test('launch accepts the widened harness enum for bare launches', async (t) => {
  const launchedArgs = [];
  t.mock.module('../dist/hcom.js', {
    namedExports: {
      resolveCallerName: async (override) => override,
      execHcom: async (args) => {
        launchedArgs.push(args);
        return { exitCode: 0, stdout: 'Names: test-agent\nBatch id: batch-123\n', stderr: '' };
      },
      listHarnessModels: async (harness) => {
        const models = { gemini: ['gemini-3.1-pro-preview'] };
        const available = models[harness] || [];
        return [{ harness, status: 'bundled', source: 'mock', models: available, count: available.length }];
      },
    },
  });
  t.mock.module('../dist/registry.js', {
    namedExports: {
      addRecord: (record) => ({ ...record, id: 'rec-1' }),
      removeRecords: () => {},
      updateRecordState: () => null,
      updateRecordVerify: () => null,
    },
  });

  const { registerLaunchTool } = await loadModule('tools/launch.js');
  const server = createFakeServer();
  registerLaunchTool(server);

  const response = await server.handlers.get('launch')({
    harness: 'gemini',
    model: 'gemini-3.1-pro-preview',
    sender_name: 'nora',
  });

  assert.equal(response.isError, undefined);
  assert.equal(launchedArgs[0][0], 'gemini');
  assert.ok(launchedArgs[0].includes('--model'));
  assert.ok(launchedArgs[0].includes('gemini-3.1-pro-preview'));
});
