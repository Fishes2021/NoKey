import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setImmediate } from 'node:timers/promises';
import vm from 'node:vm';
import ts from 'typescript';
const source = await readFile(new URL('../app/index.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('index.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const callbacks = {};
function visit(node) {
  if (ts.isVariableDeclaration(node) && ['claimPairingCode', 'forgetPairedMac', 'connectToBridge'].includes(node.name.getText(ast)))
    callbacks[node.name.getText(ast)] = node.initializer.arguments[0].getText(ast);
  ts.forEachChild(node, visit);
}
visit(ast);
const compiled = ts.transpileModule(Object.entries(callbacks).map(([name, body]) => `globalThis.${name} = ${body};`).join('\n'),
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

test('forgetting a Mac wins over late pairing, connection replies and credential writes', async () => {
  let release;
  const writing = new Promise(resolve => { release = resolve; });
  const storage = new Map(); let connects = 0;
  const context = {
    AbortController, pairingInFlight: { current: false }, pairingAbort: { current: null }, pairingSave: { current: null },
    connectionSave: { current: null }, connectionGeneration: { current: 0 }, connectionInFlight: { current: false },
    pairingDecision: { current: null }, credentialRejected: { current: false }, reconnectAttempt: { current: 0 },
    Keyboard: { dismiss() {} }, Platform: { OS: 'web' }, bridgeUrl: 'old',
    parsePairingUrl: () => ({ bridgeUrl: 'new' }),
    claimPairingPayload: async () => ({ bridgeUrl: 'new', token: 'new-token' }),
    setPairingTarget() { queueMicrotask(() => context.pairingDecision.current(true)); },
    writeStoredValue: async (key, value) => { await writing; storage.set(key, value); },
    deleteStoredValue: async key => { storage.delete(key); },
    connectToBridge: async () => { connects++; },
    finishPairingDecision() {}, registerBridgeEncryption() {}, inferBridgeUrl: () => '', announce() {},
    Haptics: { NotificationFeedbackType: {}, notificationAsync: async () => {} },
    STORAGE_URL: 'url', STORAGE_TOKEN: 'token', STORAGE_E2EE: 'encryption', STORAGE_AI_CONSENT: 'consent',
  };
  for (const name of ['setLoadingAction', 'setBridgeConnecting', 'setScannerVisible', 'setSettingsVisible', 'setBridgeUrl', 'setToken', 'setE2ee', 'setAiConsent', 'setStatus', 'setRemote']) context[name] = () => {};
  vm.runInNewContext(compiled, context);
  const pairing = context.claimPairingCode('invitation');
  await setImmediate();
  assert(context.pairingSave.current, 'credential write is in progress');
  const forgetting = context.forgetPairedMac();
  assert.equal(context.pairingAbort.current.signal.aborted, true);
  release();
  await Promise.all([pairing, forgetting]);
  assert.equal(storage.size, 0, 'late credential writes must be deleted');
  assert.equal(connects, 0, 'cancelled claim must not switch the active Mac');
  context.e2ee = null;
  context.isBridgeAuthError = () => true;
  const statuses = [];
  context.setStatus = value => statuses.push(value);
  for (const fail of [false, true]) {
    let reply, reject;
    context.bridgeRequest = () => new Promise((yes, no) => { reply = yes; reject = no; });
    const connecting = context.connectToBridge('old', 'old-token');
    await setImmediate();
    await context.forgetPairedMac();
    if (fail) reject(new Error('old authorization failed')); else reply({ remote: { online: false } });
    assert.equal(await connecting, false);
    assert.equal(storage.size, 0, 'old response must not restore credentials');
    assert.equal(statuses.at(-1), null, 'old response must not restore online state');
  }
  let finishWrite;
  const deferredWrite = new Promise(resolve => { finishWrite = resolve; });
  context.writeStoredValue = async (key, value) => { await deferredWrite; storage.set(key, value); };
  context.bridgeRequest = async () => ({ remote: { online: false } });
  const connecting = context.connectToBridge('old', 'old-token');
  await setImmediate();
  assert(context.connectionSave.current);
  const removed = context.forgetPairedMac();
  finishWrite();
  await removed;
  assert.equal(await connecting, false);
  assert.equal(storage.size, 0, 'forget deletes after in-progress connection persistence');

});
