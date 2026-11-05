import test from 'node:test';
import assert from 'node:assert/strict';
import { assertCreatedTask, assertCompletedDelivery } from '../scripts/nativeScheduleProbeAssertions.mjs';

const task = { id: 'schedule-test', sessionId: 'session-test', target: { kind: 'session', sessionId: 'session-test' }, title: 'Lvtian native probe', prompt: 'Reply LVT_SCHEDULE_PROBE_OK', kind: 'after', afterSeconds: 90, scheduledAt: new Date(90000).toISOString() };
const event = (type, seq, data) => ({ type: 'event', event: { type, seq, time: seq * 100, data } });
const catalog = [{ ...task, status: 'ended', lastDelivery: { messageId: 'delivered', deliveredAt: new Date(1000).toISOString() } }];
const records = [event('turn/start', 1, { turn: 2 }), event('user/message', 2, { id: 'delivered' }), event('assistant/message', 3, { turn: 2, message: { content: [{ type: 'text', text: 'LVT_SCHEDULE_PROBE_OK' }] } }), event('turn/end', 4, { turn: 2, reason: { kind: 'completed' } })];

test('accepts equivalent native after and at one-shot rules', () => {
  assert.equal(assertCreatedTask([task], task.sessionId, 0).id, task.id);
  assert.equal(assertCreatedTask([{ ...task, kind: 'at' }], task.sessionId, 0).id, task.id);
});

test('rejects missing, duplicate, recurring and incorrectly timed tasks', () => {
  for (const rows of [[], [task, task], [{ ...task, kind: 'every' }], [{ ...task, scheduledAt: new Date(900000).toISOString() }]]) {
    assert.throws(() => assertCreatedTask(rows, task.sessionId, 0));
  }
});

test('requires receipt-linked exact assistant output and successful turn before observation', () => {
  assert.equal(assertCompletedDelivery(catalog, task, records, 500).resultSeq, 3);
});

test('does not confuse missing task or delivery receipt with execution success', () => {
  assert.throws(() => assertCompletedDelivery([], task, records, 500));
  assert.throws(() => assertCompletedDelivery([{ ...task, status: 'ended' }], task, records, 500));
  assert.throws(() => assertCompletedDelivery(catalog, task, records.filter(row => row.event.type !== 'user/message'), 500));
});

test('rejects initial prompt text, other turns, interrupted messages and failed turns', () => {
  const replacements = [
    event('user/message', 3, { id: 'original', content: [{ type: 'text', text: 'LVT_SCHEDULE_PROBE_OK' }] }),
    event('assistant/message', 3, { ...records[2].event.data, turn: 1 }),
    event('assistant/message', 3, { ...records[2].event.data, interrupted: true }),
  ];
  for (const replacement of replacements) assert.throws(() => assertCompletedDelivery(catalog, task, [records[0], records[1], replacement, records[3]], 500));
  assert.throws(() => assertCompletedDelivery(catalog, task, [...records.slice(0, 3), event('turn/end', 4, { turn: 2, reason: { kind: 'error' } })], 500));
  assert.throws(() => assertCompletedDelivery(catalog, task, records, 400));
  assert.throws(() => assertCompletedDelivery(catalog, task, [...records.slice(0, 3), event('tool/call', 4, { turn: 2 }), event('turn/end', 5, { turn: 2, reason: { kind: 'completed' } })], 600));
  assert.throws(() => assertCompletedDelivery(catalog, task, [...records.slice(0, 3), event('assistant/message', 4, { turn: 2, message: { content: [{ type: 'text', text: 'Other final answer' }] } }), event('turn/end', 5, { turn: 2, reason: { kind: 'completed' } })], 600));
});
