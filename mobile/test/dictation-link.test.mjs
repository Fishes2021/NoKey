import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const source = fs.readFileSync(new URL('../app/index.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('index.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let toggle, connected;
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'togglePhoneDictation') toggle = node.initializer.arguments[0].getText(ast);
  if (ts.isCallExpression(node) && node.expression.getText(ast) === 'useEffect' && node.arguments[0]?.getText(ast).includes('session.pending = false')) connected = node.arguments[0].getText(ast);
  ts.forEachChild(node, visit);
}
visit(ast);
assert(toggle && connected);
const script = ts.transpileModule(`globalThis.toggle = ${toggle}; globalThis.connected = ${connected};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
test('phone delegates start and stop to Mac, consumes delay, and never sends a duplicate key', async () => {
  let sent = 0, stopped = 0, finish;
  const keyboard = { connection: 'online', target: { id: 'editor' }, dictationLeaseId: 'lease', press: () => { sent++; } };
  const phone = { active: false, state: 'idle', telemetry: { inputSelected: true, dictationManaged: true, dictationLinked: true },
    stop: async () => { stopped++; return new Promise(resolve => { finish = resolve; }); },
    toggle: async lease => { assert.equal(lease, 'lease'); phone.active = true; } };
  const c = { AppState: { currentState: 'active' }, genericKeyboard: keyboard, keyboardNow: { current: keyboard }, phoneMicrophone: phone,
    dictationSession: { current: null }, dictationStopping: { current: false }, dictationSendDelay: { current: 350 }, setNotice() {}, setNoticeError() {}, setDictationEnding() {}, setDictationLinked() {} };
  vm.runInNewContext(script, c);
  await c.toggle(); phone.state = 'speaking'; c.connected(); c.connected(); assert.equal(sent, 0);
  const stopping = c.toggle(); await c.toggle(); assert.equal(stopped, 1);
  finish({ dictationStopped: true, sendDelayMs: 800 }); assert.equal(await stopping, true);
  assert.equal(c.dictationSendDelay.current, 800); assert.equal(sent, 0);
  const failed = c.toggle(); finish({ dictationStopped: false }); assert.equal(await failed, false);
});

test('microphone starts and stops without any keyboard target or accessibility grant', async () => {
  let toggles = 0;
  const phone = { active: false, stop: async () => { toggles++; phone.active = false; }, toggle: async () => { toggles++; phone.active = !phone.active; } };
  const keyboard = { connection: 'online', target: null, message: '权限尚未就绪', press: () => { throw new Error('must not post a key'); } };
  const c = { AppState: { currentState: 'active' }, phoneMicrophone: phone, genericKeyboard: keyboard, keyboardNow: { current: keyboard }, dictationSession: { current: null }, dictationStopping: { current: false }, dictationSendDelay: { current: 350 }, setNotice() {}, setNoticeError() {}, setDictationEnding() {}, setDictationLinked() {} };
  vm.runInNewContext(script, c);
  await c.toggle(); assert.equal(toggles, 1); assert.equal(phone.active, true);
  await c.toggle(); assert.equal(toggles, 2); assert.equal(phone.active, false);
});

test('Mac-managed start does not send a duplicate toggle, but retains normal stop', async () => {
  let sent = 0, linked = false;
  const keyboard = { connection: 'online', target: { id: 'editor' }, dictationLeaseId: 'valid_lease', press: async () => { sent++; return true; } };
  const phone = { active: true, state: 'speaking', telemetry: { inputSelected: true, dictationManaged: true, dictationLinked: true }, stop: async () => { phone.active = false; } };
  const c = { AppState: { currentState: 'active' }, genericKeyboard: keyboard, keyboardNow: { current: keyboard }, phoneMicrophone: phone,
    dictationSession: { current: { target: 'editor', pending: true, request: null } }, dictationStopping: { current: false }, dictationSendDelay: { current: 350 },
    setNotice() {}, setNoticeError() {}, setDictationEnding() {}, setDictationLinked(value) { linked = value; } };
  vm.runInNewContext(script, c); c.connected(); c.connected(); assert.equal(sent, 0); assert.equal(linked, true);
  await c.toggle(); assert.equal(sent, 0); assert.equal(phone.active, false);
});

 test('offline or unchecked connection never starts phone capture', async () => {
  for (const connection of ['offline', 'checking', 'unauthorized']) {
    let captured = false;
    const c = { AppState: { currentState: 'active' }, genericKeyboard: { connection }, phoneMicrophone: { active: false, toggle() { captured = true; } }, dictationStopping: { current: false }, dictationSendDelay: { current: 350 }, setNotice() {}, setNoticeError() {} };
    vm.runInNewContext(script, c); await c.toggle(); assert.equal(captured, false);
  }
});
