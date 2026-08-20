import test from 'node:test';
import assert from 'node:assert/strict';

test('list_managed enrichment exposes report gate and dispatch evidence', async () => {
  const { enrichManagedRecord } = await import(`../dist/tools/list.js?review-views-${Date.now()}`);
  const enriched = enrichManagedRecord(
    {
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
    },
    [{ name: 'waka', base_name: 'waka', status: 'listening', tool: 'opencode' }],
  );

  assert.deepEqual(enriched.reportEvidence, {
    required: true,
    dispatchAt: '2026-08-20T00:00:00.000Z',
  });
});
