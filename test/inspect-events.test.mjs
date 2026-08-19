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

const LIVE_AGENTS = [
  { name: 'w3-vade', base_name: 'vade', status: 'listening', tag: 'w3', tool: 'opencode' },
  { name: 'team-waka', base_name: 'waka', status: 'listening', tag: 'team', tool: 'claude' },
  { name: 'zago', base_name: 'zago', status: 'listening', tag: null, tool: 'claude' },
  { name: 'solo:KELU', base_name: 'solo:KELU', status: 'listening', tag: null, tool: 'opencode' },
];

// --- #12-B2: inspect events aspect parses NDJSON without --json ---

test('inspect events drops the nonexistent --json flag and parses NDJSON per line', async (t) => {
  const calls = [];
  const eventLine = JSON.stringify({ id: 1, type: 'life', instance: 'waka', data: { action: 'ready' } });
  t.mock.module('../dist/hcom.js', {
    namedExports: {
      listHcomAgents: async () => LIVE_AGENTS,
      findLiveAgentByIdentifier: (id, agents) =>
        agents.find((a) => a.name === id || a.base_name === id) ?? null,
      canonicalizeAgentName: (id, agents) =>
        agents.find((a) => a.name === id || a.base_name === id)?.base_name ??
        (id.startsWith('@') ? id.slice(1) : id),
      execHcom: async (args) => {
        calls.push(args);
        return { exitCode: 0, stdout: `${eventLine}\n${eventLine}\n`, stderr: '' };
      },
      parseHcomJson: JSON.parse,
    },
  });
  t.mock.module('../dist/registry.js', {
    namedExports: {
      getOwnedRecordsByWorkspace: () => [],
    },
  });

  const { registerInspectTool } = await loadModule('tools/inspect.js');
  const server = createFakeServer();
  registerInspectTool(server);

  const response = await server.handlers.get('inspect')({
    name: 'waka',
    aspect: 'events',
    workspace: '/repo',
  });

  assert.equal(response.isError, undefined);
  // Exactly one hcom call, no --json flag, no fallback double-spawn.
  assert.deepEqual(calls, [['events', '--last', '20', '--agent', 'waka']]);
  const payload = JSON.parse(response.content[0].text);
  assert.equal(payload.inspect.length, 2);
  assert.equal(payload.inspect[0].data.action, 'ready');
});
