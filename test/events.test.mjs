import test from 'node:test';
import assert from 'node:assert/strict';

let importCounter = 0;

async function loadEventsModule() {
  importCounter += 1;
  return import(`../dist/events.js?review-events-${importCounter}`);
}

test('eventTimeMs treats hcom naive timestamps as UTC', async () => {
  const { eventTimeMs } = await loadEventsModule();

  assert.equal(
    eventTimeMs({ ts: '2026-08-20T07:46:57' }),
    Date.parse('2026-08-20T07:46:57Z'),
  );
});

test('newestEvent selects by parsed timestamp instead of CLI order', async () => {
  const { newestEvent } = await loadEventsModule();
  const events = [
    { id: 124623, type: 'message', ts: '2026-08-20T07:46:47', data: { from: 'rira' } },
    { id: 124640, type: 'message', ts: '2026-08-20T07:46:57', data: { from: 'rira' } },
  ];

  assert.equal(newestEvent(events).id, 124640);
});
