import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

test('foreground checks cancel on background, ignore late replies, back off offline, and stop after revoked authorization', async () => {
  const effects = [], states = [], timers = new Map(), requests = [];
  let listener, timerId = 0;
  const AppState = { currentState: 'active', addEventListener(_, fn) { listener = fn; return { remove() {} }; } };
  const react = {
    useState(initial) { const i = states.push(initial) - 1; return [initial, value => { states[i] = value; }]; },
    useRef(current) { return { current }; }, useCallback(fn) { return fn; }, useEffect(fn) { effects.push(fn); },
  };
  const context = { exports: {}, performance, AbortController, Error,
    setTimeout(fn, ms) { const id = ++timerId; timers.set(id, { fn, ms }); return id; }, clearTimeout(id) { timers.delete(id); },
    require(name) {
      if (name === 'react') return react;
      if (name === 'react-native') return { AppState };
      if (name === '@/lib/bridge') return { resetBridgeRoute() {}, currentBridgeRoute() { return null; }, bridgeRequest: (...args) => new Promise((resolve, reject) => requests.push({ args, resolve, reject })) };
      return {};
    },
  };
  const source = fs.readFileSync(new URL('../hooks/use-generic-keyboard.ts', import.meta.url), 'utf8');
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, context);
  context.exports.useGenericKeyboard('url', 'token', { keyId: 'key' }, true);
  const cleanup = effects[0]();
  const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
  assert.equal(requests.length, 1);
  AppState.currentState = 'background'; listener();
  assert.equal(requests[0].args[3].signal.aborted, true);
  requests[0].resolve({ enabled: true, trusted: true }); await flush();
  assert.equal(states[0], 'checking'); assert.equal(timers.size, 0);
  AppState.currentState = 'active'; listener(); assert.equal(requests.length, 2);
  requests[1].resolve({ enabled: false, trusted: false }); await flush();
  assert.equal(states[0], 'online', 'permission denial is not offline');
  let [id, timer] = [...timers][0]; assert.equal(timer.ms, 1000); timers.delete(id); timer.fn();
  requests[2].reject(Object.assign(new Error('offline'), { code: 'MAC_OFFLINE' })); await flush();
  assert.equal(states[0], 'offline');
  [id, timer] = [...timers][0]; assert.equal(timer.ms, 2000);
  AppState.currentState = 'background'; listener(); assert.equal(timers.size, 0);
  AppState.currentState = 'active'; listener();
  requests[3].reject(Object.assign(new Error('revoked'), { name: 'BridgeAuthError' })); await flush();
  assert.equal(states[0], 'unauthorized'); assert.equal(timers.size, 0);
  AppState.currentState = 'background'; listener(); AppState.currentState = 'active'; listener();
  assert.equal(requests.length, 4, 'revoked authorization does not retry on resume'); cleanup();
});
