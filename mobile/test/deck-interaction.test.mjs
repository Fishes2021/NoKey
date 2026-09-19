import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
function extract(file, name, callback = false) {
  const source = fs.readFileSync(new URL(file, import.meta.url), 'utf8');
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let code;
  function visit(n) {
    if (ts.isFunctionDeclaration(n) && n.name?.text === name) code = n.getText(ast).replace(/^export /, '');
    if (callback && ts.isVariableDeclaration(n) && n.name.getText(ast) === name) code = `const ${name} = ${n.initializer.arguments[0].getText(ast)};`;
    ts.forEachChild(n, visit);
  }
  visit(ast); assert(code);
  return ts.transpileModule(`${code};globalThis.run = ${name}`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
}
const send = extract('../app/index.tsx', 'runProgrammedKey', true);
test('send ends dictation first, suppresses duplicate taps and never sends after failed stop or target change', async () => {
  for (const outcome of ['ok', 'failed', 'changed']) {
    const calls = []; let finish;
    const c = { keysReady: true, keysSaving: false, programmedKeys: [null,null,null,{ action: { type: 'shortcut', key: 'Enter', modifiers: [] } }],
      dictationSendDelay: { current: 350 }, sendInFlight: { current: false }, dictationActive: true, announce() {}, flashProgrammedKey() {}, LED: { complete: '', error: '' },
      keyboardNow: { current: { target: { id: 'editor' }, press: async () => { calls.push('send'); return true; } } },
      togglePhoneDictation: () => { calls.push('stop'); return new Promise(resolve => { finish = resolve; }); },
      setTimeout: callback => { calls.push('settle'); callback(); } };
    vm.runInNewContext(send, c);
    const pending = c.run(3); await c.run(3); assert.deepEqual(calls, ['stop']);
    if (outcome === 'changed') c.keyboardNow.current.target.id = 'other';
    finish(outcome !== 'failed'); await pending;
    assert.equal(calls.includes('send'), outcome === 'ok');
    assert.equal(c.sendInFlight.current, false);
  }
});
test('angular rotation crosses the +/-180 seam smoothly in either direction', () => {
  const c = {}; vm.runInNewContext(extract('../components/reasoning-dial.tsx', 'rotationDelta'), c);
  assert.equal(c.run(175, -175), 10); assert.equal(c.run(-175, 175), -10);
  assert.equal(c.run(0, 90), 90); assert.equal(c.run(90, 0), -90);
});
test('encoder sends every crossed step and stops when foreground target changes', async () => {
  const code = extract('../hooks/use-generic-keyboard.ts', 'moveCursor', true);
  for (const change of [false,true]) {
    const calls = [];
    const c = { identity: 'phone', current: { current: 'phone' }, AppState: { currentState: 'active' },
      validLease: { current: { identity: 'phone', target: { id: 'editor' } } },
      movement: { current: { steps: 0, running: false, identity: '', target: '' } }, sending: { current: false },
      setTimeout: callback => { queueMicrotask(callback); },
      pressNow: { current: async (key, continuous) => { assert.equal(continuous, true); calls.push(key.key); if (change) c.validLease.current.target.id = 'other'; return true; } } };
    vm.runInNewContext(code, c); c.run(1, 4);
    for (let i = 0; i < 20; i++) await Promise.resolve();
    assert.equal(calls.length, change ? 1 : 4);
    assert(calls.every(key => key === 'ArrowRight'));
  }
});


test('continuous cursor keys never toggle global busy or transient feedback; errors remain visible', async () => {
  const code = extract('../hooks/use-generic-keyboard.ts', 'press', true);
  for (const [continuous, fail] of [[true, false], [true, true], [false, false]]) {
    const target = { identity: 'phone', target: { id: 'editor', name: 'Editor' }, leaseId: 'lease', expires: 3000 };
    const busy = [], results = [], calls = [];
    const c = { Error, enabled: true, e2ee: {}, identity: 'phone', current: { current: 'phone' },
      AppState: { currentState: 'active' }, performance: { now: () => 1 },
      validLease: { current: target }, lease: target, sending: { current: false }, message: '',
      setBusy: value => busy.push(value), setResult: value => results.push(value),
      normalizeShortcut: value => value, randomE2EEId: async () => 'op', url: 'local', token: 'token',
      bridgeRequest: async (...args) => { calls.push(args); if (fail) throw new Error('offline');
        return { operationId: 'op', posted: true, target: target.target, message: 'sent' }; } };
    vm.runInNewContext(code, c);
    assert.equal(await c.run({ key: 'ArrowRight', modifiers: [] }, continuous), !fail);
    assert.equal(calls.length, 1); assert.equal(c.sending.current, false);
    assert.deepEqual(busy, continuous ? [] : [true, false]);
    if (continuous) assert(!results.includes('正在发送按键'));
    if (fail) assert(results.some(value => value.includes('offline')));
  }
});


test('joystick resolves taps and drags with a neutral centre and sends only configured generic shortcuts', async () => {
  const c = {};
  vm.runInNewContext(extract('../components/joystick.tsx', 'joystickDirection'), c);
  for (const [x, y, result] of [[0, -25, 'up'], [25, 0, 'right'], [0, 25, 'down'], [-25, 0, 'left'], [0, 0, null], [2, 2, null]]) {
    assert.equal(c.run(x, y, 6), result);
  }
  const calls = [], edits = [];
  const shortcut = { type: 'shortcut', key: 'F', modifiers: ['command'] };
  const state = { keysReady: true, keysSaving: false, keysDevice: 'phone', dictationActive: false, joystickSession: {current:null}, programmedKeys: Array(10).fill(null),
    openKeyEditor: slot => edits.push(slot), genericKeyboard: { target:{id:'editor'}, press: async (action, quiet) => { calls.push([action, quiet]); return true; } } };
  state.programmedKeys[7] = { action: shortcut };
  vm.runInNewContext(extract('../app/index.tsx', 'handleJoystickDirection', true), state);
  await state.run('right', false); await state.run('right', true); await state.run('up', false);
  assert.deepEqual(calls, [[shortcut, true]]); assert.deepEqual(edits, []);
  state.keysReady = false; await state.run('right'); assert.equal(calls.length, 1);
});
