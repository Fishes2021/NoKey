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
test('dictation toggles once per explicit start/stop, not on reconnect; stopping waits for the start reply', async () => {
  let sent = 0, stopped = 0, finish;
  const keyboard = { target: { id: 'editor' }, press: () => { sent++; return sent === 1 ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(true); } };
  const phone = { active: false, state: 'idle', telemetry: { inputSelected: false }, stop: async () => { stopped++; phone.active = false; }, toggle: async () => { if (phone.active) stopped++; phone.active = !phone.active; } };
  const c = { genericKeyboard: keyboard, keyboardNow: { current: keyboard }, phoneMicrophone: phone,
    dictationSession: { current: null }, dictationStopping: { current: false }, setNotice() {}, setNoticeError() {}, setDictationEnding() {}, setDictationLinked() {} };
  vm.runInNewContext(script, c);
  await c.toggle(); assert.equal(sent, 0);
  phone.state = 'speaking'; c.connected(); assert.equal(sent, 0, 'wait for confirmed system input');
  phone.telemetry.inputSelected = true; c.connected(); c.connected(); assert.equal(sent, 1);
  const stopping = c.toggle(); assert.equal(stopped, 0, 'keep capture until stop shortcut completes');
  await c.toggle(); assert.equal(phone.active, true, 'do not toggle during pending stop');
  finish(true); await stopping; assert.equal(stopped, 1); assert.equal(sent, 2); assert.equal(c.dictationStopping.current, false);
  phone.active = true; c.dictationSession.current = { target: 'old-app', request: Promise.resolve(true) };
  await c.toggle(); assert.equal(sent, 2, 'do not toggle a different foreground app');
});

test('microphone starts and stops without any keyboard target or accessibility grant', async () => {
  let toggles = 0;
  const phone = { active: false, stop: async () => { toggles++; phone.active = false; }, toggle: async () => { toggles++; phone.active = !phone.active; } };
  const keyboard = { target: null, message: '权限尚未就绪', press: () => { throw new Error('must not post a key'); } };
  const c = { phoneMicrophone: phone, genericKeyboard: keyboard, keyboardNow: { current: keyboard }, dictationSession: { current: null }, dictationStopping: { current: false }, setNotice() {}, setNoticeError() {}, setDictationEnding() {}, setDictationLinked() {} };
  vm.runInNewContext(script, c);
  await c.toggle(); assert.equal(toggles, 1); assert.equal(phone.active, true);
  await c.toggle(); assert.equal(toggles, 2); assert.equal(phone.active, false);
});
