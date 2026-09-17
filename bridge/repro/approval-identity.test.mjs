import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { EventEmitter } from 'node:events';

// Simulate the Codex transport only; never spawn Codex or send real approvals.
mock.module('node:child_process', { namedExports: { spawn() {
  const child = new EventEmitter();
  child.stderr = Object.assign(new EventEmitter(), { setEncoding() {}, destroy() {} });
  child.kill = () => { child.signalCode = 'SIGTERM'; child.emit('exit'); };
  child.unref = () => {};
  return child;
} } });
const { CodexAppServer } = await import('../lib/codex-app-server.mjs');
const { executeProgrammedAction } = await import('../lib/programmed-actions.mjs');

test('approval identity binds both entry paths to the displayed request and selected task', async () => {
  const original = globalThis.WebSocket;
  let socket;
  const replies = [];
  globalThis.WebSocket = class extends EventTarget {
    static OPEN = 1;
    readyState = 1;
    constructor() { super(); socket = this; queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
    receive(message) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) })); }
    send(raw) {
      const message = JSON.parse(raw);
      if (message.method === 'initialize') queueMicrotask(() => this.receive({ id: message.id, result: {} }));
      else if (!message.method) replies.push(message);
    }
    close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
  };
  const codex = new CodexAppServer({ lazy: true });
  const approval = { requestId: 'approval-1', threadId: 'thread-1' };
  codex.state = async () => ({ selectedThreadId: 'thread-1', pendingApproval: approval });
  const incoming = (requestId, threadId) => socket.receive({ id: requestId, method: 'item/commandExecution/requestApproval', params: { threadId } });
  const stale = error => error.statusCode === 409;
  try {
    await codex.ready();
    codex.markSelectedThread('thread-1');
    incoming('approval-1', 'thread-1'); incoming('approval-2', 'thread-2');
    await assert.rejects(codex.resolveApproval('approve'), stale);
    await assert.rejects(codex.resolveApproval('approve', { ...approval, requestId: 'old-approval' }), stale);
    await assert.rejects(codex.resolveApproval('approve', { ...approval, threadId: 'thread-2' }), stale);
    codex.markSelectedThread('thread-2');
    await assert.rejects(codex.resolveApproval('approve', approval), stale);
    assert.equal(replies.length, 0);
    codex.markSelectedThread('thread-1');
    await executeProgrammedAction({ commandId: 'approval.approve', approval, codex });
    assert.deepEqual(replies, [{ id: 'approval-1', result: { decision: 'accept' } }]);
    // A new approval must not receive a repeated decision intended for the old one.
    incoming('approval-3', 'thread-1');
    await assert.rejects(executeProgrammedAction({ commandId: 'approval.approve', approval, codex }), stale);
    await assert.rejects(executeProgrammedAction({ commandId: 'approval.decline', approval, codex,
      resolveApproval: (decision, expected) => codex.resolveApproval(decision, expected) }), stale);
    assert.equal(replies.length, 1);
    const next = { requestId: 'approval-3', threadId: 'thread-1' };
    await codex.resolveApproval('decline', next);
    assert.deepEqual(replies[1], { id: 'approval-3', result: { decision: 'decline' } });
    await assert.rejects(codex.resolveApproval('invalid', next), error => error.statusCode === 400);
  } finally {
    codex.close(); globalThis.WebSocket = original;
  }
});
