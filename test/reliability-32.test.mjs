import test from 'node:test';
import assert from 'node:assert/strict';

let importCounter = 0;

async function loadModule() {
  importCounter += 1;
  return import(`../dist/tools/watch.js?reliability32-${importCounter}`);
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

function record() {
  return {
    id: 'record-1',
    workspace: '/repo',
    harness: 'opencode',
    hcomName: 'waka',
    state: 'managed_active',
    createdAt: '2026-08-20T00:00:00.000Z',
    lastSeenAt: '2026-08-20T00:00:00.000Z',
    released: false,
  };
}

function mockWatchDeps(t, { events, unreadCount = 0, execHcom }) {
  t.mock.module('../dist/hcom.js', {
    namedExports: {
      canonicalizeAgentName: (name) => name.replace(/^@/, ''),
      execHcom,
      findLiveAgentByIdentifier: (name, agents) =>
        agents.find((agent) => agent.name === name || agent.base_name === name) ?? null,
      listHcomAgents: async () => [{
        name: 'waka',
        base_name: 'waka',
        tool: 'opencode',
        status: 'listening',
        status_age_seconds: 0,
        unread_count: unreadCount,
        tag: null,
      }],
      parseHcomJson: JSON.parse,
      resolveCallerName: async (override) => override,
    },
  });
  t.mock.module('../dist/registry.js', {
    namedExports: {
      getOwnedRecordsByWorkspace: () => [record()],
    },
  });
  return events;
}

test('watch_agents flags an OpenCode queue wedged for exactly 600 seconds and fetches term only then', async (t) => {
  const dispatchAt = new Date(Date.now() - 600_000).toISOString();
  const calls = [];
  const events = [
    {
      type: 'status',
      instance: 'waka',
      ts: new Date().toISOString(),
      data: { status: 'listening', context: 'idle' },
    },
    {
      type: 'message',
      instance: 'hub',
      ts: dispatchAt,
      data: { from: 'hub', intent: 'request', text: 'process the queued task' },
    },
  ];
  mockWatchDeps(t, {
    events,
    execHcom: async (args) => {
      calls.push(args);
      if (args[0] === 'events') {
        return { exitCode: 0, stdout: events.map((event) => JSON.stringify(event)).join('\n'), stderr: '' };
      }
      if (args[0] === 'term') {
        return { exitCode: 0, stdout: JSON.stringify({ lines: ['queued prompt', 'listening'] }), stderr: '' };
      }
      throw new Error(`unexpected args: ${args.join(' ')}`);
    },
  });

  const { registerWatchAgentsTool } = await loadModule();
  const server = createFakeServer();
  registerWatchAgentsTool(server);
  const response = await server.handlers.get('watch_agents')({ workspace: '/repo' });

  assert.equal(response.isError, undefined);
  const payload = JSON.parse(response.content[0].text);
  const agent = payload.agents[0];
  assert.ok(agent.flags.includes('wedged_queue'));
  assert.equal(agent.wedgedQueue.evidenceTimestamp, dispatchAt);
  assert.ok(agent.wedgedQueue.ageSeconds >= 600);
  assert.match(agent.wedgedQueue.termTail, /listening/);
  assert.equal(payload.summary.wedged_queue, 1);
  assert.equal(calls.filter((args) => args[0] === 'term').length, 1);
  assert.equal(calls.some((args) => args[0] === 'stop' || args[0] === 'kill'), false);
});

test('watch_agents ignores non-actionable inform and ack traffic even when unread_count is nonzero', async (t) => {
  const old = new Date(Date.now() - 900_000).toISOString();
  const calls = [];
  const events = [
    { type: 'message', instance: 'hub', ts: old, data: { from: 'hub', intent: 'inform', text: 'FYI' } },
    { type: 'message', instance: 'hub', ts: old, data: { from: 'hub', intent: 'ack', text: 'acknowledged' } },
  ];
  mockWatchDeps(t, {
    events,
    unreadCount: 3,
    execHcom: async (args) => {
      calls.push(args);
      if (args[0] === 'events') {
        return { exitCode: 0, stdout: events.map((event) => JSON.stringify(event)).join('\n'), stderr: '' };
      }
      throw new Error(`term must not run for a non-wedged queue: ${args.join(' ')}`);
    },
  });

  const { registerWatchAgentsTool } = await loadModule();
  const server = createFakeServer();
  registerWatchAgentsTool(server);
  const response = await server.handlers.get('watch_agents')({ workspace: '/repo' });
  const agent = JSON.parse(response.content[0].text).agents[0];

  assert.equal(agent.flags.includes('wedged_queue'), false);
  assert.equal(agent.flags.includes('unreported'), true);
  assert.equal(calls.some((args) => args[0] === 'term'), false);
});

test('watch_agents clears wedged_queue when the agent replies after dispatch', async (t) => {
  const old = new Date(Date.now() - 900_000).toISOString();
  const reply = new Date().toISOString();
  const calls = [];
  const events = [
    { type: 'message', instance: 'hub', ts: old, data: { from: 'hub', intent: 'request', text: 'do work' } },
    { type: 'message', instance: 'waka', ts: reply, data: { from: 'waka', intent: 'ack', text: 'received' } },
  ];
  mockWatchDeps(t, {
    events,
    execHcom: async (args) => {
      calls.push(args);
      if (args[0] === 'events') {
        return { exitCode: 0, stdout: events.map((event) => JSON.stringify(event)).join('\n'), stderr: '' };
      }
      throw new Error(`term must not run after consumption evidence: ${args.join(' ')}`);
    },
  });

  const { registerWatchAgentsTool } = await loadModule();
  const server = createFakeServer();
  registerWatchAgentsTool(server);
  const response = await server.handlers.get('watch_agents')({ workspace: '/repo' });
  const agent = JSON.parse(response.content[0].text).agents[0];

  assert.equal(agent.flags.includes('wedged_queue'), false);
  assert.equal(calls.some((args) => args[0] === 'term'), false);
});

test('watch_agents clears wedged_queue when post-dispatch activity proves consumption', async (t) => {
  const old = new Date(Date.now() - 900_000).toISOString();
  const active = new Date(Date.now() - 899_000).toISOString();
  const calls = [];
  const events = [
    { type: 'message', instance: 'hub', ts: old, data: { from: 'hub', intent: 'request', text: 'do work' } },
    { type: 'status', instance: 'waka', ts: active, data: { new_status: 'active', new_context: 'tool:read' } },
  ];
  mockWatchDeps(t, {
    events,
    execHcom: async (args) => {
      calls.push(args);
      if (args[0] === 'events') {
        return { exitCode: 0, stdout: events.map((event) => JSON.stringify(event)).join('\n'), stderr: '' };
      }
      throw new Error(`term must not run after activity evidence: ${args.join(' ')}`);
    },
  });

  const { registerWatchAgentsTool } = await loadModule();
  const server = createFakeServer();
  registerWatchAgentsTool(server);
  const response = await server.handlers.get('watch_agents')({ workspace: '/repo' });
  const agent = JSON.parse(response.content[0].text).agents[0];

  assert.equal(agent.flags.includes('wedged_queue'), false);
  assert.equal(calls.some((args) => args[0] === 'term'), false);
});
