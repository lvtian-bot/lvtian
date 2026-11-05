import assert from 'node:assert/strict';

export function assertCreatedTask(catalog, sessionId, requestedAt) {
  const owned = catalog.filter(entry => entry.target.kind === 'session' && entry.target.sessionId === sessionId);
  assert.equal(owned.length, 1, 'Exactly one task must be created');
  const task = owned[0];
  const oneShot = (task.kind === 'after' && task.afterSeconds === 90) || task.kind === 'at';
  assert.ok(oneShot, 'Expected an equivalent one-shot rule');
  const delay = Date.parse(task.scheduledAt) - requestedAt;
  assert.ok(delay >= 80000 && delay <= 120000, 'Unexpected native scheduled time');
  assert.equal(task.title, 'Lvtian native probe');
  assert.ok(task.prompt.includes('LVT_SCHEDULE_PROBE_OK'));
  return task;
}

export function assertCompletedDelivery(catalog, task, records, observedAt) {
  const restored = catalog.find(entry => entry.id === task.id && entry.target.kind === 'session' && task.target.kind === 'session' && entry.target.sessionId === task.target.sessionId);
  assert.equal(restored?.status, 'ended', 'One-shot task must remain as inactive');
  assert.ok(restored.lastDelivery, 'Missing durable delivery receipt');
  const events = records.map(record => record.event);
  const receipt = restored.lastDelivery;
  const delivered = events.find(event => event.type === 'user/message' && event.data?.id === receipt.messageId);
  assert.ok(delivered, 'Receipt must identify a real delivered message');
  const turn = events.filter(event => event.type === 'turn/start' && event.seq < delivered.seq).at(-1)?.data?.turn;
  assert.notEqual(turn, undefined, 'Delivered message must belong to a turn');
  const answers = events.filter(event => event.type === 'assistant/message' && event.seq > delivered.seq && event.data?.turn === turn);
  const answer = answers.at(-1);
  assert.ok(answer && !answer.data.interrupted, 'Missing final uninterrupted assistant result');
  assert.equal(answer.data.message?.content?.filter(block => block.type === 'text').map(block => block.text).join(''), 'LVT_SCHEDULE_PROBE_OK', 'Final answer must match exactly');
  assert.ok(!events.some(event => event.type === 'tool/call' && event.data?.turn === turn), 'Probe execution must not call tools');
  const ended = events.find(event => event.type === 'turn/end' && event.data?.turn === turn && event.seq > answer.seq);
  assert.equal(ended?.data?.reason?.kind, 'completed', 'Execution must end successfully');
  assert.ok(ended.time < observedAt, 'Execution must complete before reconnect observation');
  return { taskId: task.id, sessionId: task.target.sessionId, deliveredAt: receipt.deliveredAt, resultSeq: answer.seq, turnEnd: ended.data };
}
