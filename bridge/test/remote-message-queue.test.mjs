import assert from 'node:assert/strict';
import test from 'node:test';

import { RemoteMessageQueue } from '../lib/remote-message-queue.mjs';

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

test('messages wait in order while Codex is busy and queued items can be removed', async () => {
  let status = 'thinking';
  let nextId = 0;
  const sent = [];
  const queue = new RemoteMessageQueue({
    getState: async () => ({
      threads: [{ id: 'thread-1', status }],
    }),
    send: async (item) => sent.push(item.text),
    makeId: () => `message-${++nextId}`,
    now: () => 123,
  });

  const first = queue.enqueue({ threadId: 'thread-1', text: 'first' });
  const second = queue.enqueue({ threadId: 'thread-1', text: 'second' });
  await flush();

  assert.deepEqual(sent, []);
  assert.deepEqual(queue.list().map((item) => item.text), ['first', 'second']);
  assert.equal(queue.remove(second.id), true);
  assert.deepEqual(queue.list().map((item) => item.text), ['first']);

  status = 'complete';
  await queue.handleCodexChange();
  assert.deepEqual(sent, ['first']);
  assert.deepEqual(
    queue.list().map(({ text, status: itemStatus }) => ({ text, status: itemStatus })),
    [{ text: 'first', status: 'sending' }],
  );

  status = 'thinking';
  await queue.handleCodexChange();
  status = 'complete';
  await queue.handleCodexChange();
  assert.deepEqual(queue.list(), []);
  queue.close();
});

test('the next queued message sends only after the active Codex turn completes', async () => {
  let status = 'complete';
  let nextId = 0;
  const sent = [];
  const queue = new RemoteMessageQueue({
    getState: async () => ({
      threads: [{ id: 'thread-1', status }],
    }),
    send: async (item) => sent.push(item.text),
    makeId: () => `message-${++nextId}`,
  });

  queue.enqueue({ threadId: 'thread-1', text: 'one' });
  queue.enqueue({ threadId: 'thread-1', text: 'two' });
  await flush();
  assert.deepEqual(sent, ['one']);
  assert.deepEqual(
    queue.list().map(({ text, status: itemStatus }) => ({ text, status: itemStatus })),
    [
      { text: 'one', status: 'sending' },
      { text: 'two', status: 'queued' },
    ],
  );

  status = 'thinking';
  await queue.handleCodexChange();
  assert.deepEqual(sent, ['one']);

  status = 'complete';
  await queue.handleCodexChange();
  assert.deepEqual(sent, ['one', 'two']);
  assert.deepEqual(
    queue.list().map(({ text, status: itemStatus }) => ({ text, status: itemStatus })),
    [{ text: 'two', status: 'sending' }],
  );

  status = 'thinking';
  await queue.handleCodexChange();
  status = 'complete';
  await queue.handleCodexChange();
  assert.deepEqual(queue.list(), []);
  queue.close();
});

test('a dispatched message stays visible as sending until the Codex turn completes', async () => {
  let status = 'complete';
  let nextId = 0;
  const sent = [];
  const queue = new RemoteMessageQueue({
    getState: async () => ({
      threads: [{ id: 'thread-1', status }],
    }),
    send: async (item) => sent.push(item.text),
    makeId: () => `message-${++nextId}`,
  });

  queue.enqueue({ threadId: 'thread-1', text: 'keep me visible' });
  await flush();

  assert.deepEqual(sent, ['keep me visible']);
  assert.deepEqual(
    queue.list().map(({ text, status: itemStatus }) => ({ text, status: itemStatus })),
    [{ text: 'keep me visible', status: 'sending' }],
  );

  status = 'thinking';
  await queue.handleCodexChange();
  assert.deepEqual(queue.list().map((item) => item.status), ['sending']);

  status = 'complete';
  await queue.handleCodexChange();
  assert.deepEqual(queue.list(), []);
  queue.close();
});

test('archiving a chat removes only its waiting messages', async () => {
  const queue = new RemoteMessageQueue({
    getState: async () => ({
      threads: [
        { id: 'thread-1', status: 'thinking' },
        { id: 'thread-2', status: 'thinking' },
      ],
    }),
    send: async () => {},
    makeId: (() => {
      let id = 0;
      return () => `message-${++id}`;
    })(),
  });

  queue.enqueue({ threadId: 'thread-1', text: 'remove me' });
  queue.enqueue({ threadId: 'thread-2', text: 'keep me' });
  await flush();

  assert.equal(queue.removeThread('thread-1'), 1);
  assert.deepEqual(queue.list().map((item) => item.text), ['keep me']);
  queue.close();
});

test('a failed desktop send stays queued instead of crashing the bridge', async () => {
  const queue = new RemoteMessageQueue({
    getState: async () => ({
      threads: [{ id: 'thread-1', status: 'complete' }],
    }),
    send: async () => {
      throw new Error('Desktop composer is unavailable');
    },
    makeId: () => 'message-1',
  });

  queue.enqueue({ threadId: 'thread-1', text: 'try again later' });
  await flush();

  assert.deepEqual(queue.list(), [
    {
      id: 'message-1',
      threadId: 'thread-1',
      text: 'try again later',
      status: 'queued',
      createdAt: queue.list()[0].createdAt,
      error: 'Desktop composer is unavailable',
    },
  ]);
  queue.close();
});

test('an uncertain send is never retried by state changes or later enqueues', async () => {
  const sent = [];
  const queue = new RemoteMessageQueue({
    getState: async () => ({ threads: [{ id: 'thread-1', status: 'complete' }] }),
    send: async item => { sent.push(item.text); throw new Error('reply lost after delivery'); },
  });
  try {
    const first = queue.enqueue({ threadId: 'thread-1', text: 'possibly delivered' });
    await flush();
    await queue.handleCodexChange();
    queue.enqueue({ threadId: 'thread-1', text: 'later message' });
    await flush();
    await queue.drain();
    assert.deepEqual(sent, ['possibly delivered']);
    assert.equal(queue.list()[0].error, 'reply lost after delivery');
    assert.equal(queue.remove(first.id), true, 'user can dismiss the uncertain item');
  } finally { queue.close(); }
});

test('closing while state is loading cancels the pending send', async () => {
  let resolveState;
  const state = new Promise(resolve => { resolveState = resolve; });
  const sent = [];
  const queue = new RemoteMessageQueue({ getState: () => state, send: async item => sent.push(item.text) });
  queue.enqueue({ threadId: 'thread-1', text: 'must not send' });
  await flush();
  queue.close();
  resolveState({ threads: [{ id: 'thread-1', status: 'complete' }] });
  await flush();
  assert.deepEqual(sent, []);
  assert.deepEqual(queue.list(), []);
  assert.throws(() => queue.enqueue({ threadId: 'thread-1', text: 'closed' }), /停止/);
});

test('removing while state is loading cancels that pending item', async () => {
  let resolveState;
  const state = new Promise(resolve => { resolveState = resolve; });
  const sent = [];
  const queue = new RemoteMessageQueue({ getState: () => state, send: async item => sent.push(item.text) });
  try {
    const item = queue.enqueue({ threadId: 'thread-1', text: 'removed' });
    await flush();
    assert.equal(queue.remove(item.id), true);
    resolveState({ threads: [{ id: 'thread-1', status: 'complete' }] });
    await flush();
    assert.deepEqual(sent, []);
  } finally { queue.close(); }
});

test('closing aborts desktop preparation and ignores its late completion', async () => {
  let release;
  const prepared = new Promise(resolve => { release = resolve; });
  let signal;
  const sent = [];
  const queue = new RemoteMessageQueue({
    getState: async () => ({ threads: [{ id: 'thread-1', status: 'complete' }] }),
    send: async (item, lifetime) => {
      signal = lifetime;
      await prepared;
      lifetime.throwIfAborted();
      sent.push(item.text);
    },
  });
  queue.enqueue({ threadId: 'thread-1', text: 'cancel preparation' });
  await flush();
  assert.equal(signal.aborted, false);
  queue.close();
  assert.equal(signal.aborted, true);
  release();
  await flush();
  await queue.handleCodexChange();
  assert.deepEqual(sent, []);
  assert.deepEqual(queue.list(), []);
  queue.close();
});

test('revocation removes only the requesting device messages and aborts preparation', async () => {
  let release;
  const prepared = new Promise(resolve => { release = resolve; });
  const sent = [];
  let signal;
  const queue = new RemoteMessageQueue({
    getState: async () => ({ threads: [{ id: 'thread-1', status: 'complete' }] }),
    send: async (item, lifetime, owner) => {
      if (owner === 'phone-a') { signal = lifetime; await prepared; }
      lifetime.throwIfAborted();
      sent.push(item.text);
    },
  });
  try {
    queue.enqueue({ threadId: 'thread-1', text: 'cancel active', owner: 'phone-a' });
    queue.enqueue({ threadId: 'thread-1', text: 'cancel waiting', owner: 'phone-a' });
    queue.enqueue({ threadId: 'thread-1', text: 'keep', owner: 'phone-b' });
    await flush();
    queue.revoke('phone-a');
    assert.equal(signal.aborted, true);
    assert.deepEqual(queue.list().map(item => item.text), ['keep']);
    assert.equal('owner' in queue.list()[0], false, 'internal identity stays out of queue payload');
    release();
    await flush();
    await queue.handleCodexChange();
    assert.deepEqual(sent, ['keep']);
  } finally { queue.close(); }
});

test('Codex state failure is contained and pending messages do not resume automatically', async () => {
  let failed = false;
  const sent = [];
  const queue = new RemoteMessageQueue({
    getState: async () => {
      if (failed) throw new Error('Codex disconnected');
      return { threads: [{ id: 'thread-1', status: 'thinking' }] };
    },
    send: async item => sent.push(item.text),
  });
  try {
    queue.enqueue({ threadId: 'thread-1', text: 'waiting' });
    await flush();
    failed = true;
    await assert.doesNotReject(queue.handleCodexChange());
    assert.match(queue.list()[0].error, /暂停/);
    failed = false;
    await queue.drain({ threads: [{ id: 'thread-1', status: 'complete' }] });
    assert.deepEqual(sent, []);
  } finally { queue.close(); }
});

test('a late successful state read cannot resume a queue paused by a newer failure', async () => {
  let resolve, reads = 0;
  const pending = new Promise(done => { resolve = done; });
  const sent = [];
  const queue = new RemoteMessageQueue({
    getState: () => ++reads === 1 ? pending : Promise.reject(new Error('disconnected')),
    send: async item => sent.push(item.text),
  });
  try {
    queue.enqueue({ threadId: 'thread-1', text: 'do not resume' });
    await flush();
    await queue.handleCodexChange();
    resolve({ threads: [{ id: 'thread-1', status: 'complete' }] });
    await flush();
    assert.deepEqual(sent, []);
    assert.match(queue.list()[0].error, /暂停/);
  } finally { queue.close(); }
});
