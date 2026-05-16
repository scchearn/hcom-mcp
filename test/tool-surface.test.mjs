import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  registerLaunchTool,
  registerTopologyLaunchTool,
  validatePresetModelAvailability,
} from '../dist/tools/launch.js';
import * as listModule from '../dist/tools/list.js';
import { registerListModelsTool, registerModelResources } from '../dist/tools/models.js';
import * as hcomModule from '../dist/hcom.js';
import { registerInspectTool } from '../dist/tools/inspect.js';
import { registerLifecycleTools } from '../dist/tools/lifecycle.js';
import * as configModule from '../dist/config.js';

const { registerListManagedTool, matchLiveAgent, reconcileManagedRecords } = listModule;
const { getConfigPaths, summarizeAgentPresets, summarizeTopologyPresets } = configModule;
const { listHarnessModels } = hcomModule;

function createWorkspaceConfig(config) {
  const workspace = mkdtempSync(join(tmpdir(), 'hcom-mcp-'));
  writeFileSync(join(workspace, '.hcom-mcp.json'), JSON.stringify(config, null, 2));
  return workspace;
}

function createFakeServer() {
  const names = [];
  const handlers = new Map();
  const resources = [];
  const resourceHandlers = new Map();
  return {
    names,
    handlers,
    resources,
    resourceHandlers,
    tool(name, _description, _schema, handler) {
      names.push(name);
      handlers.set(name, handler);
    },
    registerResource(name, uri, metadata, handler) {
      resources.push({ name, uri, metadata });
      resourceHandlers.set(name, handler);
    },
  };
}

test('registerLaunchTool exposes the bare launch name', () => {
  const server = createFakeServer();
  registerLaunchTool(server);
  assert.deepEqual(server.names, ['launch']);
});

test('registerTopologyLaunchTool exposes the bare launch_topology name', () => {
  const server = createFakeServer();
  registerTopologyLaunchTool(server);
  assert.deepEqual(server.names, ['launch_topology']);
});

test('launch hints callers toward list_presets when a preset is missing', async () => {
  const server = createFakeServer();
  registerLaunchTool(server);

  const response = await server.handlers.get('launch')({ preset: 'does-not-exist' });

  assert.equal(response.isError, true);
  assert.match(response.content[0].text, /Use list_presets/i);
});

test('launch_topology hints callers toward list_topologies when a topology is missing', async () => {
  const server = createFakeServer();
  registerTopologyLaunchTool(server);

  const response = await server.handlers.get('launch_topology')({ topology: 'does-not-exist' });

  assert.equal(response.isError, true);
  assert.match(response.content[0].text, /Use list_topologies/i);
});

test('launch_topology expands roles by count and tracks each launched worker', async (t) => {
  const launchedArgs = [];
  const addedRecords = [];

  t.mock.module('../dist/hcom.js', {
    namedExports: {
      execHcom: async (args) => {
        launchedArgs.push(args);
        const workerNumber = launchedArgs.length;
        return {
          exitCode: 0,
          stdout: `Names: worker-${workerNumber}\nBatch id: batch-${workerNumber}\n`,
          stderr: '',
        };
      },
      listHarnessModels: async (harness) => {
        const models = { claude: ['haiku'] };
        const available = models[harness] || [];
        return [{ harness, status: 'live', source: 'mock', models: available, count: available.length }];
      },
    },
  });

  t.mock.module('../dist/registry.js', {
    namedExports: {
      addRecord: (record) => {
        addedRecords.push(record);
        return {
          ...record,
          id: `record-${addedRecords.length}`,
          createdAt: '2026-05-16T00:00:00.000Z',
          lastSeenAt: '2026-05-16T00:00:00.000Z',
        };
      },
      removeRecords: () => {},
    },
  });

  t.mock.module('../dist/config.js', {
    namedExports: {
      loadMergedConfig: () => ({
        agentPresets: {
          reviewer: {
            name: 'reviewer',
            harness: {
              claude: { model: 'haiku' },
            },
            headless: true,
            pty: false,
          },
        },
        topologyPresets: {
          swarm: {
            name: 'swarm',
            roles: [
              { role: 'review', preset: 'reviewer', harness: 'claude', count: 3 },
            ],
          },
        },
      }),
      resolveAgentPreset: (config, name) => config.agentPresets[name] || null,
      resolveTopologyPreset: (config, name) => config.topologyPresets[name] || null,
      validateTopologyReferences: () => [],
    },
  });

  const { registerTopologyLaunchTool } = await import('../dist/tools/launch.js?' + Date.now());
  const server = createFakeServer();
  registerTopologyLaunchTool(server);

  const response = await server.handlers.get('launch_topology')({
    topology: 'swarm',
    workspace: '/repo',
  });

  assert.ok(!response.isError, response?.content?.[0]?.text);
  const payload = JSON.parse(response.content[0].text);
  assert.equal(payload.totalAgents, 3);
  assert.equal(payload.launched.length, 3);
  assert.equal(launchedArgs.length, 3);
  assert.equal(addedRecords.length, 3);
  assert.deepEqual(addedRecords.map((record) => record.hcomName), ['worker-1', 'worker-2', 'worker-3']);
});

test('launch_topology rolls back every tracked record when a later launch fails', async (t) => {
  const removedRecordIds = [];
  const killTargets = [];
  let addRecordCount = 0;
  let launchCount = 0;

  t.mock.module('../dist/hcom.js', {
    namedExports: {
      execHcom: async (args) => {
        if (args[0] === 'kill') {
          killTargets.push(args[1]);
          return { exitCode: 0, stdout: '', stderr: '' };
        }

        launchCount += 1;
        if (launchCount === 1) {
          return {
            exitCode: 0,
            stdout: 'Names: alpha beta\nBatch id: batch-1\n',
            stderr: '',
          };
        }

        return {
          exitCode: 1,
          stdout: '',
          stderr: 'launch failed',
        };
      },
      listHarnessModels: async (harness) => {
        const models = { claude: ['haiku'] };
        const available = models[harness] || [];
        return [{ harness, status: 'live', source: 'mock', models: available, count: available.length }];
      },
    },
  });

  t.mock.module('../dist/registry.js', {
    namedExports: {
      addRecord: (record) => {
        addRecordCount += 1;
        return {
          ...record,
          id: `record-${addRecordCount}`,
          createdAt: '2026-05-16T00:00:00.000Z',
          lastSeenAt: '2026-05-16T00:00:00.000Z',
        };
      },
      removeRecords: (ids) => {
        removedRecordIds.push(...ids);
      },
    },
  });

  t.mock.module('../dist/config.js', {
    namedExports: {
      loadMergedConfig: () => ({
        agentPresets: {
          reviewer: {
            name: 'reviewer',
            harness: {
              claude: { model: 'haiku' },
            },
            headless: true,
            pty: false,
          },
          builder: {
            name: 'builder',
            harness: {
              claude: { model: 'haiku' },
            },
            headless: true,
            pty: false,
          },
        },
        topologyPresets: {
          duo: {
            name: 'duo',
            roles: [
              { role: 'review', preset: 'reviewer', harness: 'claude', count: 1 },
              { role: 'build', preset: 'builder', harness: 'claude', count: 1 },
            ],
          },
        },
      }),
      resolveAgentPreset: (config, name) => config.agentPresets[name] || null,
      resolveTopologyPreset: (config, name) => config.topologyPresets[name] || null,
      validateTopologyReferences: () => [],
    },
  });

  const { registerTopologyLaunchTool } = await import('../dist/tools/launch.js?' + Date.now());
  const server = createFakeServer();
  registerTopologyLaunchTool(server);

  const response = await server.handlers.get('launch_topology')({
    topology: 'duo',
    workspace: '/repo',
  });

  assert.equal(response.isError, true);
  assert.match(response.content[0].text, /rolled back 1 agents/i);
  assert.deepEqual(removedRecordIds, ['record-1', 'record-2']);
  assert.deepEqual(killTargets, ['alpha', 'beta']);
});

test('registerListManagedTool exposes the bare list_managed name', () => {
  const server = createFakeServer();
  registerListManagedTool(server);
  assert.deepEqual(server.names, ['list_managed']);
});

test('registerInspectTool exposes the bare inspect name', () => {
  const server = createFakeServer();
  registerInspectTool(server);
  assert.deepEqual(server.names, ['inspect']);
});

test('registerLifecycleTools exposes bare lifecycle names', () => {
  const server = createFakeServer();
  registerLifecycleTools(server);
  assert.deepEqual(server.names, ['stop', 'kill', 'promote']);
});

test('matchLiveAgent matches by base_name when the live name is tag-prefixed', () => {
  assert.equal(typeof matchLiveAgent, 'function');

  const matched = matchLiveAgent(
    { hcomName: 'lemo' },
    [
      { name: 'research-lemo', base_name: 'lemo', status: 'listening' },
      { name: 'verify-zama', base_name: 'zama', status: 'listening' },
    ],
  );

  assert.equal(matched?.name, 'research-lemo');
});

test('reconcileManagedRecords marks missing unreleased records as managed_lost', () => {
  assert.equal(typeof reconcileManagedRecords, 'function');

  const records = [
    {
      id: '1',
      workspace: '/repo',
      harness: 'opencode',
      hcomName: 'lemo',
      launchMode: 'headless',
      state: 'managed_active',
      createdAt: '2026-05-14T00:00:00.000Z',
      lastSeenAt: '2026-05-14T00:00:00.000Z',
      released: false,
    },
    {
      id: '2',
      workspace: '/repo',
      harness: 'opencode',
      hcomName: 'zama',
      launchMode: 'headless',
      state: 'managed_active',
      createdAt: '2026-05-14T00:00:00.000Z',
      lastSeenAt: '2026-05-14T00:00:00.000Z',
      released: false,
    },
    {
      id: '3',
      workspace: '/repo',
      harness: 'opencode',
      hcomName: 'mike',
      launchMode: 'headless',
      state: 'managed_stopped',
      createdAt: '2026-05-14T00:00:00.000Z',
      lastSeenAt: '2026-05-14T00:00:00.000Z',
      released: false,
    },
  ];

  const reconciled = reconcileManagedRecords(records, [
    { name: 'research-lemo', base_name: 'lemo', status: 'listening' },
  ]);

  assert.equal(reconciled[0].state, 'managed_active');
  assert.equal(reconciled[1].state, 'managed_lost');
  assert.equal(reconciled[2].state, 'managed_stopped');
});

test('getConfigPaths returns the expected path filenames', () => {
  assert.equal(typeof getConfigPaths, 'function');

  const paths = getConfigPaths('/repo');

  assert.equal(paths.globalConfig.path.endsWith('/.hcom/mcp/config.json'), true);
  assert.equal(paths.workspaceConfig.path, '/repo/.hcom-mcp.json');
  assert.equal(paths.registry.path.endsWith('/.hcom/mcp/registry.json'), true);
});

test('summarizeAgentPresets returns prompt-presence flags instead of prompt text', () => {
  assert.equal(typeof summarizeAgentPresets, 'function');

  const presets = summarizeAgentPresets({
    researcher: {
      name: 'researcher',
      harness: {
        claude: { model: 'haiku' },
        opencode: { model: 'opencode/deepseek-v4-flash-free' },
      },
      headless: true,
      pty: false,
      tag: 'research',
      prompt: 'hello',
      systemPrompt: 'system',
    },
  });

  assert.deepEqual(presets, [
    {
      name: 'researcher',
      supportedHarnesses: ['claude', 'opencode'],
      modelsByHarness: {
        claude: 'haiku',
        opencode: 'opencode/deepseek-v4-flash-free',
      },
      headless: true,
      pty: false,
      tag: 'research',
      hasDir: false,
      hasPrompt: true,
      hasSystemPrompt: true,
    },
  ]);
});

test('summarizeTopologyPresets reports role counts and missing presets', () => {
  assert.equal(typeof summarizeTopologyPresets, 'function');

  const topologies = summarizeTopologyPresets(
    {
      agentPresets: {
        researcher: {
          name: 'researcher',
          harness: {
            opencode: { model: 'opencode/deepseek-v4-flash-free' },
          },
          headless: true,
          pty: false,
        },
      },
      topologyPresets: {
        squad: {
          name: 'squad',
          roles: [
            { role: 'one', preset: 'researcher', harness: 'opencode', count: 1 },
            { role: 'two', preset: 'missing', harness: 'claude', count: 1 },
          ],
          threadPrefix: 'squad',
        },
      },
    },
  );

  assert.deepEqual(topologies, [
    {
      name: 'squad',
      roleCount: 2,
      roles: [
        { role: 'one', preset: 'researcher', harness: 'opencode', count: 1 },
        { role: 'two', preset: 'missing', harness: 'claude', count: 1 },
      ],
      hub: null,
      threadPrefix: 'squad',
      missingPresets: ['missing'],
    },
  ]);
});

test('launch requires an explicit harness', async (t) => {
  const workspace = createWorkspaceConfig({
    agentPresets: {
      'research-assistant': {
        name: 'research-assistant',
        harness: {
          opencode: { model: 'opencode/deepseek-v4-flash-free' },
          claude: { model: 'haiku' },
        },
        headless: true,
        pty: false,
      },
    },
    topologyPresets: {},
  });
  t.after(() => rmSync(workspace, { recursive: true, force: true }));

  const server = createFakeServer();
  registerLaunchTool(server);

  const response = await server.handlers.get('launch')({
    preset: 'research-assistant',
    workspace,
  });

  assert.equal(response.isError, true);
  assert.match(response.content[0].text, /explicit harness/i);
});

test('launch reports supported harnesses when the preset does not support the requested harness', async (t) => {
  const workspace = createWorkspaceConfig({
    agentPresets: {
      researcher: {
        name: 'researcher',
        harness: {
          opencode: { model: 'opencode/deepseek-v4-flash-free' },
        },
        headless: true,
        pty: false,
      },
    },
    topologyPresets: {},
  });
  t.after(() => rmSync(workspace, { recursive: true, force: true }));

  const server = createFakeServer();
  registerLaunchTool(server);

  const response = await server.handlers.get('launch')({
    preset: 'researcher',
    harness: 'claude',
    workspace,
  });

  assert.equal(response.isError, true);
  assert.match(response.content[0].text, /Supported: opencode/i);
});

test('registerListModelsTool exposes the bare list_models name', () => {
  const server = createFakeServer();
  registerListModelsTool(server);
  assert.deepEqual(server.names, ['list_models']);
});

test('registerModelResources exposes all fixed model resource URIs', () => {
  const server = createFakeServer();

  registerModelResources(server);

  assert.deepEqual(
    server.resources.map((resource) => resource.uri),
    [
      'hcom://models',
      'hcom://models/claude',
      'hcom://models/opencode',
      'hcom://models/codex',
    ],
  );
});

test('listHarnessModels returns live opencode results with models present', async () => {
  assert.equal(typeof listHarnessModels, 'function');

  const results = await listHarnessModels('opencode');

  assert.equal(results.length, 1);
  const [opencode] = results;
  assert.equal(opencode.harness, 'opencode');
  assert.equal(opencode.status, 'live');
  assert.equal(opencode.source, 'opencode models CLI');
  assert.equal(typeof opencode.count, 'number');
  assert.equal(Array.isArray(opencode.models), true);
  assert.equal(opencode.models.length > 0, true);
  assert.equal(opencode.models.every((model) => model.includes('/')), true);
  assert.equal(opencode.count, opencode.models.length);
});

test('listHarnessModels returns bundled catalog for claude', async () => {
  const results = await listHarnessModels('claude');

  assert.equal(results.length, 1);
  const [claude] = results;
  assert.equal(claude.harness, 'claude');
  assert.equal(claude.status, 'bundled');
  assert.equal(claude.source, 'bundled catalog');
  assert.equal(claude.models.includes('sonnet'), true);
  assert.equal(claude.models.includes('haiku'), true);
  assert.equal(claude.count, claude.models.length);
});

test('listHarnessModels returns bundled catalog for codex', async () => {
  const results = await listHarnessModels('codex');

  assert.equal(results.length, 1);
  const [codex] = results;
  assert.equal(codex.harness, 'codex');
  assert.equal(codex.status, 'bundled');
  assert.equal(codex.source, 'bundled catalog');
  assert.equal(codex.models.includes('gpt-5.5'), true);
  assert.equal(codex.models.includes('gpt-5.4'), true);
  assert.equal(codex.count, codex.models.length);
});

test('listHarnessModels returns all harnesses when no harness specified', async () => {
  const results = await listHarnessModels();

  assert.equal(results.length, 3);
  const statuses = results.map((r) => r.status);
  assert.ok(statuses.includes('live'));
  assert.equal(statuses.includes('bundled'), true);
  assert.equal(statuses.includes('unsupported'), false);
});

test('model resources return bundled catalog payloads', async () => {
  const server = createFakeServer();

  registerModelResources(server);

  const result = await server.resourceHandlers.get('models-claude')();
  const payload = JSON.parse(result.contents[0].text);

  assert.equal(payload.harness, 'claude');
  assert.equal(payload.status, 'bundled');
  assert.equal(payload.models.includes('opus'), true);
});

test('validatePresetModelAvailability accepts known bundled models', async () => {
  const error = await validatePresetModelAvailability({
    name: 'reviewer',
    harness: 'claude',
    model: 'sonnet',
  });

  assert.equal(error, null);
});

test('validatePresetModelAvailability accepts claude extended-context suffixes', async () => {
  const error = await validatePresetModelAvailability({
    name: 'planner',
    harness: 'claude',
    model: 'sonnet[1m]',
  });

  assert.equal(error, null);
});

test('validatePresetModelAvailability rejects unknown bundled models', async () => {
  const error = await validatePresetModelAvailability({
    name: 'builder',
    harness: 'codex',
    model: 'not-a-real-codex-model',
  });

  assert.match(error, /not found/i);
});

test('bare launch without model or preset returns error', async () => {
  const server = createFakeServer();
  registerLaunchTool(server);

  const response = await server.handlers.get('launch')({
    harness: 'claude',
  });

  assert.equal(response.isError, true);
  assert.match(response.content[0].text, /provide at least a preset or a model/i);
});

test('bare launch with harness + model builds correct command', async (t) => {
  let capturedArgs;
  const mockHarnessModels = {
    claude: ['sonnet', 'haiku'],
    opencode: ['opencode/deepseek-v4-flash-free'],
    codex: ['gpt-5.5'],
  };

  t.mock.module('../dist/hcom.js', {
    namedExports: {
      execHcom: async (args) => {
        capturedArgs = args;
        return { exitCode: 0, stdout: 'Names: test-agent\nBatch id: batch-123\n', stderr: '' };
      },
      listHarnessModels: async (harness) => {
        const models = mockHarnessModels[harness] || [];
        return [{ harness, status: 'live', source: 'mock', models, count: models.length }];
      },
    },
  });

  const { registerLaunchTool } = await import('../dist/tools/launch.js?' + Date.now());
  const server = createFakeServer();
  registerLaunchTool(server);

  const response = await server.handlers.get('launch')({
    harness: 'claude',
    model: 'sonnet',
  });

  assert.ok(!response.isError);
  assert.ok(capturedArgs);
  const commandStr = capturedArgs.join(' ');
  assert.match(commandStr, /--model sonnet/);
  assert.match(commandStr, /--tag claude/);
  assert.match(commandStr, /--headless/);
  assert.match(commandStr, /--hcom-prompt Wait for instructions from the hub\./);
  assert.match(commandStr, /--go/);
});

test('preset + model override uses the override model', async (t) => {
  const workspace = createWorkspaceConfig({
    agentPresets: {
      researcher: {
        name: 'researcher',
        harness: {
          opencode: { model: 'opencode/deepseek-v4-flash-free' },
        },
        headless: true,
        pty: false,
      },
    },
    topologyPresets: {},
  });
  t.after(() => rmSync(workspace, { recursive: true, force: true }));

  let capturedArgs;
  const mockHarnessModels = {
    claude: ['sonnet', 'haiku'],
    opencode: ['custom-model', 'opencode/deepseek-v4-flash-free'],
    codex: ['gpt-5.5'],
  };

  t.mock.module('../dist/hcom.js', {
    namedExports: {
      execHcom: async (args) => {
        capturedArgs = args;
        return { exitCode: 0, stdout: 'Names: test-agent\nBatch id: batch-123\n', stderr: '' };
      },
      listHarnessModels: async (harness) => {
        const models = mockHarnessModels[harness] || [];
        return [{ harness, status: 'live', source: 'mock', models, count: models.length }];
      },
    },
  });

  t.mock.module('../dist/config.js', {
    namedExports: {
      loadMergedConfig: () => ({
        agentPresets: {
          researcher: {
            name: 'researcher',
            harness: {
              opencode: { model: 'opencode/deepseek-v4-flash-free' },
            },
            headless: true,
            pty: false,
          },
        },
        topologyPresets: {},
      }),
      resolveAgentPreset: (config, name) => config.agentPresets[name] || null,
      resolveTopologyPreset: () => null,
      validateTopologyReferences: () => [],
      getConfigPaths: configModule.getConfigPaths,
      summarizeAgentPresets: configModule.summarizeAgentPresets,
      summarizeTopologyPresets: configModule.summarizeTopologyPresets,
    },
  });

  const { registerLaunchTool } = await import('../dist/tools/launch.js?' + Date.now());
  const server = createFakeServer();
  registerLaunchTool(server);

  const response = await server.handlers.get('launch')({
    preset: 'researcher',
    harness: 'opencode',
    model: 'custom-model',
    workspace,
  });

  assert.ok(!response.isError);
  assert.ok(capturedArgs);
  const commandStr = capturedArgs.join(' ');
  assert.match(commandStr, /--model custom-model/);
});

test('bare launch tag defaults to harness name', async (t) => {
  let capturedArgs;
  const mockHarnessModels = {
    claude: ['sonnet', 'haiku'],
  };

  t.mock.module('../dist/hcom.js', {
    namedExports: {
      execHcom: async (args) => {
        capturedArgs = args;
        return { exitCode: 0, stdout: 'Names: test-agent\nBatch id: batch-123\n', stderr: '' };
      },
      listHarnessModels: async (harness) => {
        const models = mockHarnessModels[harness] || [];
        return [{ harness, status: 'live', source: 'mock', models, count: models.length }];
      },
    },
  });

  const { registerLaunchTool } = await import('../dist/tools/launch.js?' + Date.now());
  const server = createFakeServer();
  registerLaunchTool(server);

  const response = await server.handlers.get('launch')({
    harness: 'claude',
    model: 'sonnet',
  });

  assert.ok(!response.isError);
  assert.ok(capturedArgs);
  const commandStr = capturedArgs.join(' ');
  assert.match(commandStr, /--tag claude/);
});

test('custom tag overrides default', async (t) => {
  let capturedArgs;
  const mockHarnessModels = {
    claude: ['haiku'],
  };

  t.mock.module('../dist/hcom.js', {
    namedExports: {
      execHcom: async (args) => {
        capturedArgs = args;
        return { exitCode: 0, stdout: 'Names: test-agent\nBatch id: batch-123\n', stderr: '' };
      },
      listHarnessModels: async (harness) => {
        const models = mockHarnessModels[harness] || [];
        return [{ harness, status: 'live', source: 'mock', models, count: models.length }];
      },
    },
  });

  const { registerLaunchTool } = await import('../dist/tools/launch.js?' + Date.now());
  const server = createFakeServer();
  registerLaunchTool(server);

  const response = await server.handlers.get('launch')({
    harness: 'claude',
    model: 'haiku',
    tag: 'review',
  });

  assert.ok(!response.isError);
  assert.ok(capturedArgs);
  const commandStr = capturedArgs.join(' ');
  assert.match(commandStr, /--tag review/);
});

test('headless opencode launch injects OPENCODE_CONFIG_CONTENT with permissions and reasoning variant', async (t) => {
  const workspace = createWorkspaceConfig({ agentPresets: {}, topologyPresets: {} });
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  let capturedArgs;
  let capturedOptions;

  t.mock.module('../dist/hcom.js', {
    namedExports: {
      execHcom: async (args, options) => {
        capturedArgs = args;
        capturedOptions = options;
        return { exitCode: 0, stdout: 'Names: test-agent\nBatch id: batch-123\n', stderr: '' };
      },
      listHarnessModels: async (harness) => {
        const models = { opencode: ['opencode/deepseek-v4-flash-free'] };
        const m = models[harness] || [];
        return [{ harness, status: 'live', source: 'mock', models: m, count: m.length }];
      },
    },
  });

  t.mock.module('../dist/config.js', {
    namedExports: {
      loadMergedConfig: () => ({
        agentPresets: {
          'doc-writer': {
            name: 'doc-writer',
            harness: {
              opencode: { model: 'opencode/deepseek-v4-flash-free', reasoning: 'max' },
            },
            headless: true,
            pty: false,
          },
        },
        topologyPresets: {},
      }),
      resolveAgentPreset: (config, name) => config.agentPresets[name] || null,
      resolveTopologyPreset: () => null,
      validateTopologyReferences: () => [],
      getConfigPaths: configModule.getConfigPaths,
      summarizeAgentPresets: configModule.summarizeAgentPresets,
      summarizeTopologyPresets: configModule.summarizeTopologyPresets,
    },
  });

  const { registerLaunchTool } = await import('../dist/tools/launch.js?' + Date.now());
  const server = createFakeServer();
  registerLaunchTool(server);

  const response = await server.handlers.get('launch')({
    preset: 'doc-writer',
    harness: 'opencode',
    workspace,
  });

  assert.ok(!response.isError, response?.content?.[0]?.text);
  assert.ok(capturedArgs);
  // No cwd overlay — the broken delivery path is not used.
  assert.equal(capturedOptions?.cwd, undefined);
  // Permissions and reasoning delivered via OPENCODE_CONFIG_CONTENT, not broken overlay or rejected flags.
  const configContent = JSON.parse(capturedOptions?.env?.OPENCODE_CONFIG_CONTENT ?? 'null');
  assert.ok(configContent, 'OPENCODE_CONFIG_CONTENT must be set');
  assert.equal(configContent.permission['*'], 'allow');
  assert.equal(configContent.permission.external_directory, 'allow');
  assert.equal(configContent.agent?.coder?.variant, 'max');
  assert.equal(configContent.agent?.orchestrator?.variant, 'max');
  const commandStr = capturedArgs.join(' ');
  // headless opencode: variant NOT passed as direct arg (opencode serve rejects it)
  assert.doesNotMatch(commandStr, /--variant/);
});

test('headless opencode launch injects OPENCODE_CONFIG_CONTENT with permissions, no cwd overlay', async (t) => {
  const workspace = createWorkspaceConfig({
    agentPresets: {
      builder: {
        name: 'builder',
        harness: {
          opencode: { model: 'opencode/deepseek-v4-flash-free' },
        },
        headless: true,
        pty: false,
      },
    },
    topologyPresets: {},
  });
  t.after(() => rmSync(workspace, { recursive: true, force: true }));

  let capturedArgs;
  let capturedOptions;

  t.mock.module('../dist/hcom.js', {
    namedExports: {
      execHcom: async (args, options) => {
        capturedArgs = args;
        capturedOptions = options;
        return { exitCode: 0, stdout: 'Names: test-agent\nBatch id: batch-123\n', stderr: '' };
      },
      listHarnessModels: async (harness) => {
        const models = { opencode: ['opencode/deepseek-v4-flash-free'] };
        const m = models[harness] || [];
        return [{ harness, status: 'live', source: 'mock', models: m, count: m.length }];
      },
    },
  });

  const { registerLaunchTool } = await import('../dist/tools/launch.js?' + Date.now());
  const server = createFakeServer();
  registerLaunchTool(server);

  const response = await server.handlers.get('launch')({
    preset: 'builder',
    harness: 'opencode',
    workspace,
  });

  assert.ok(!response.isError, response?.content?.[0]?.text);
  assert.ok(capturedArgs);
  // No cwd overlay — the broken delivery path is not used.
  assert.equal(capturedOptions?.cwd, undefined);
  // Permissions injected via OPENCODE_CONFIG_CONTENT env var that hcom does not overwrite.
  const configContent = JSON.parse(capturedOptions?.env?.OPENCODE_CONFIG_CONTENT ?? 'null');
  assert.ok(configContent, 'OPENCODE_CONFIG_CONTENT must be set');
  assert.equal(configContent.permission['*'], 'allow');
  assert.equal(configContent.permission.external_directory, 'allow');
  // No reasoning = no agent config block
  assert.equal(configContent.agent, undefined);
});

test('claude harness with reasoning xhigh includes --effort xhigh', async (t) => {
  let capturedArgs;

  t.mock.module('../dist/hcom.js', {
    namedExports: {
      execHcom: async (args) => {
        capturedArgs = args;
        return { exitCode: 0, stdout: 'Names: test-agent\nBatch id: batch-123\n', stderr: '' };
      },
      listHarnessModels: async (harness) => {
        const models = { claude: ['sonnet'] };
        const m = models[harness] || [];
        return [{ harness, status: 'live', source: 'mock', models: m, count: m.length }];
      },
    },
  });

  const { registerLaunchTool } = await import('../dist/tools/launch.js?' + Date.now());
  const server = createFakeServer();
  registerLaunchTool(server);

  const response = await server.handlers.get('launch')({
    harness: 'claude',
    model: 'sonnet',
    reasoning: 'xhigh',
  });

  assert.ok(!response.isError, response?.content?.[0]?.text);
  assert.ok(capturedArgs);
  const commandStr = capturedArgs.join(' ');
  assert.match(commandStr, /--effort xhigh/);
});

test('no reasoning produces no --variant or --effort flag', async (t) => {
  let capturedArgs;

  t.mock.module('../dist/hcom.js', {
    namedExports: {
      execHcom: async (args) => {
        capturedArgs = args;
        return { exitCode: 0, stdout: 'Names: test-agent\nBatch id: batch-123\n', stderr: '' };
      },
      listHarnessModels: async (harness) => {
        const models = { opencode: ['opencode/deepseek-v4-flash-free'] };
        const m = models[harness] || [];
        return [{ harness, status: 'live', source: 'mock', models: m, count: m.length }];
      },
    },
  });

  const { registerLaunchTool } = await import('../dist/tools/launch.js?' + Date.now());
  const server = createFakeServer();
  registerLaunchTool(server);

  const response = await server.handlers.get('launch')({
    harness: 'opencode',
    model: 'opencode/deepseek-v4-flash-free',
  });

  assert.ok(!response.isError, response?.content?.[0]?.text);
  assert.ok(capturedArgs);
  const commandStr = capturedArgs.join(' ');
  assert.doesNotMatch(commandStr, /--variant/);
  assert.doesNotMatch(commandStr, /--effort/);
});

test('codex harness with reasoning produces no flag', async (t) => {
  let capturedArgs;

  t.mock.module('../dist/hcom.js', {
    namedExports: {
      execHcom: async (args) => {
        capturedArgs = args;
        return { exitCode: 0, stdout: 'Names: test-agent\nBatch id: batch-123\n', stderr: '' };
      },
      listHarnessModels: async (harness) => {
        const models = { codex: ['gpt-5.5'] };
        const m = models[harness] || [];
        return [{ harness, status: 'live', source: 'mock', models: m, count: m.length }];
      },
    },
  });

  const { registerLaunchTool } = await import('../dist/tools/launch.js?' + Date.now());
  const server = createFakeServer();
  registerLaunchTool(server);

  const response = await server.handlers.get('launch')({
    harness: 'codex',
    model: 'gpt-5.5',
    reasoning: 'high',
  });

  assert.ok(!response.isError, response?.content?.[0]?.text);
  assert.ok(capturedArgs);
  const commandStr = capturedArgs.join(' ');
  assert.doesNotMatch(commandStr, /--variant/);
  assert.doesNotMatch(commandStr, /--effort/);
});

test('bare launch with reasoning uses correct flag per harness', async (t) => {
  let capturedArgs;

  t.mock.module('../dist/hcom.js', {
    namedExports: {
      execHcom: async (args) => {
        capturedArgs = args;
        return { exitCode: 0, stdout: 'Names: test-agent\nBatch id: batch-123\n', stderr: '' };
      },
      listHarnessModels: async (harness) => {
        const models = { opencode: ['opencode/deepseek-v4-flash-free'] };
        const m = models[harness] || [];
        return [{ harness, status: 'live', source: 'mock', models: m, count: m.length }];
      },
    },
  });

  const { registerLaunchTool } = await import('../dist/tools/launch.js?' + Date.now());
  const server = createFakeServer();
  registerLaunchTool(server);

  const response = await server.handlers.get('launch')({
    harness: 'opencode',
    model: 'opencode/deepseek-v4-flash-free',
    reasoning: 'turbo',
  });

  assert.ok(!response.isError, response?.content?.[0]?.text);
  assert.ok(capturedArgs);
  const commandStr = capturedArgs.join(' ');
  // headless opencode: --variant NOT passed as direct arg (opencode serve rejects it)
  assert.doesNotMatch(commandStr, /--variant/);
});
