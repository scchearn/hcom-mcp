import test from 'node:test';
import assert from 'node:assert/strict';

let importCounter = 0;

async function loadModule() {
  importCounter += 1;
  return import(`../dist/tools/lifecycle.js?reliability31-${importCounter}`);
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

function record(overrides = {}) {
  return {
    id: 'record-1',
    workspace: '/repo',
    harness: 'opencode',
    hcomName: 'waka',
    state: 'managed_active',
    createdAt: '2026-08-20T00:00:00.000Z',
    lastSeenAt: '2026-08-20T00:00:00.000Z',
    released: false,
    requireReport: true,
    dispatchAt: '2026-08-20T00:00:00.000Z',
    ...overrides,
  };
}

function mockLifecycleDeps(t, { records, liveAgents, execHcom }) {
  t.mock.module('../dist/hcom.js', {
    namedExports: {
      canonicalizeAgentName: (name) => name.replace(/^@/, ''),
      execHcom,
      findLiveAgentByIdentifier: (name, agents) =>
        agents.find((agent) => agent.name === name || agent.base_name === name) ?? null,
      listHcomAgents: async () => liveAgents,
      resolveCallerName: async (override) => override,
    },
  });
  t.mock.module('../dist/registry.js', {
    namedExports: {
      getOwnedRecordsByWorkspace: () => records,
      updateRecordState: () => null,
    },
  });
}

test('stop refuses a report-promising worker without a post-dispatch message', async (t) => {
  const calls = [];
  mockLifecycleDeps(t, {
    records: [record()],
    liveAgents: [{ name: 'waka', base_name: 'waka', status: 'listening' }],
    execHcom: async (args) => {
      calls.push(args);
      if (args[0] === 'events') {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            type: 'message',
            ts: '2026-08-19T23:59:59.000Z',
            data: { from: 'other', text: 'not the worker report' },
          }),
          stderr: '',
        };
      }
      throw new Error('stop must not run before the report gate passes');
    },
  });

  const { registerLifecycleTools } = await loadModule();
  const server = createFakeServer();
  registerLifecycleTools(server);
  const response = await server.handlers.get('stop')({
    names: ['waka'],
    workspace: '/repo',
    sender_name: 'nora',
  });

  assert.equal(response.isError, true);
  assert.match(response.content[0].text, /E_REPORT_REQUIRED/);
  assert.match(response.content[0].text, /force=true/);
  assert.equal(calls.filter((args) => args[0] === 'stop').length, 0);
});

test('kill accepts an agent-originated message after dispatch', async (t) => {
  const calls = [];
  mockLifecycleDeps(t, {
    records: [record()],
    liveAgents: [{ name: 'waka', base_name: 'waka', status: 'listening' }],
    execHcom: async (args) => {
      calls.push(args);
      if (args[0] === 'events') {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            type: 'message',
            ts: '2026-08-20T00:00:01.000Z',
            data: { from: 'waka', text: 'final report' },
          }),
          stderr: '',
        };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  });

  const { registerLifecycleTools } = await loadModule();
  const server = createFakeServer();
  registerLifecycleTools(server);
  const response = await server.handlers.get('kill')({
    names: ['waka'],
    workspace: '/repo',
    sender_name: 'nora',
  });

  assert.equal(response.isError, undefined);
  const payload = JSON.parse(response.content[0].text);
  assert.equal(payload.killed, 1);
  assert.deepEqual(calls.find((args) => args[0] === 'kill'), ['kill', 'waka', '--go']);
});

test('force bypasses only the report gate and still executes kill', async (t) => {
  const calls = [];
  mockLifecycleDeps(t, {
    records: [record()],
    liveAgents: [{ name: 'waka', base_name: 'waka', status: 'listening' }],
    execHcom: async (args) => {
      calls.push(args);
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  });

  const { registerLifecycleTools } = await loadModule();
  const server = createFakeServer();
  registerLifecycleTools(server);
  const response = await server.handlers.get('kill')({
    names: ['waka'],
    force: true,
    workspace: '/repo',
    sender_name: 'nora',
  });

  assert.equal(response.isError, undefined);
  assert.equal(calls.some((args) => args[0] === 'events'), false);
  assert.deepEqual(calls, [['kill', 'waka', '--go']]);
});

test('tag teardown applies the report gate to every owned target', async (t) => {
  const calls = [];
  mockLifecycleDeps(t, {
    records: [record({ id: 'one', hcomName: 'one' }), record({ id: 'two', hcomName: 'two' })],
    liveAgents: [
      { name: 'one', base_name: 'one', tag: 'batch', status: 'listening' },
      { name: 'two', base_name: 'two', tag: 'batch', status: 'listening' },
    ],
    execHcom: async (args) => {
      calls.push(args);
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  });

  const { registerLifecycleTools } = await loadModule();
  const server = createFakeServer();
  registerLifecycleTools(server);
  const response = await server.handlers.get('stop')({
    tag: 'batch',
    workspace: '/repo',
    sender_name: 'nora',
  });

  assert.equal(response.isError, true);
  const payload = JSON.parse(response.content[0].text);
  assert.equal(payload.stopped, 0);
  assert.equal(payload.failed, 2);
  assert.equal(calls.filter((args) => args[0] === 'events').length, 2);
  assert.equal(calls.some((args) => args[0] === 'stop'), false);
});
