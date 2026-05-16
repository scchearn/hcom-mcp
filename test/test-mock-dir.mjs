import test from 'node:test';
import assert from 'node:assert/strict';

test('mock.module with dynamic import in test dir - fixed', async (t) => {
  let capturedArgs;
  t.mock.module('../dist/hcom.js', {
    namedExports: {
      execHcom: async (args) => {
        capturedArgs = args;
        return { exitCode: 0, stdout: 'Names: test-agent\nBatch id: batch-123\n', stderr: '' };
      },
      listHarnessModels: async (harness) => {
        return [{ harness, status: 'live', source: 'mock', models: ['sonnet'], count: 1 }];
      },
    },
  });

  const { registerLaunchTool } = await import('../dist/tools/launch.js');
  const server = {
    names: [],
    handlers: new Map(),
    tool(name, _desc, _schema, handler) {
      this.names.push(name);
      this.handlers.set(name, handler);
    },
  };
  registerLaunchTool(server);

  const response = await server.handlers.get('launch')({
    harness: 'claude',
    model: 'sonnet',
  });

  console.log('response:', response);
  console.log('capturedArgs:', capturedArgs);
  assert.ok(!response.isError);
  assert.ok(capturedArgs);
  const commandStr = capturedArgs.join(' ');
  assert.match(commandStr, /--model sonnet/);
  assert.match(commandStr, /--tag claude/);
  assert.match(commandStr, /--headless/);
});
