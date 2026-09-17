import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setImmediate } from 'node:timers/promises';
import vm from 'node:vm';
import ts from 'typescript';

const source = await readFile(new URL('../hooks/use-phone-microphone.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
} }).outputText;

test('late stop success or failure cannot overwrite the next microphone session', async () => {
  for (const [fail, restart] of [[false, true], [true, true], [false, false], [true, false]]) {
    // Minimal hook storage; run the real hook, replacing only React scheduling,
    // storage and media dependencies. No native capture or network requests.
    const slots = []; let cursor = 0, settle;
    const react = {
      useState(initial) {
        const index = cursor++;
        if (!(index in slots)) slots[index] = initial;
        return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }];
      },
      useRef(initial) { const index = cursor++; return slots[index] ??= { current: initial }; },
      useCallback: callback => callback,
      useEffect(callback) { const index = cursor++; if (!(index in slots)) { slots[index] = true; callback(); } },
    };
    class Sender {
      constructor(options) { this.options = options; }
      async start() { this.options.onState('speaking'); }
      stop() {
        this.options.onState('idle');
        return new Promise((resolve, reject) => { settle = () => fail ? reject(new Error('late failure')) : resolve(); });
      }
    }
    const modules = {
      react, 'react-native': { Platform: { OS: 'ios' } },
      '../lib/voice-sender.mjs': { VoiceSender: Sender },
      '../lib/phone-audio-capture.mjs': { createPhoneAudioCapture: () => ({ stop() {}, getStream() {} }) },
      '../lib/ice-config.mjs': { validateIceConfig: value => value },
      '../lib/bridge': { bridgeRequest: () => { throw new Error('Unexpected network call'); } },
      '../lib/storage': { readStoredValue: async () => null, writeStoredValue: async () => {} },
      'react-native-webrtc': {}, '../modules/voicedeck-audio': { default: {} },
    };
    const exports = {};
    vm.runInNewContext(compiled, { exports, Error, require(name) { assert(name in modules, name); return modules[name]; } });
    const material = { keyId: 'test-key', key: 'unused' };
    const render = () => { cursor = 0; return exports.usePhoneMicrophone('http://test.invalid', 'token', material); };
    render(); await setImmediate();
    await render().toggle();
    assert.equal(render().state, 'speaking');
    const stopping = render().toggle();
    assert.equal(render().state, 'idle');
    assert.equal(render().message, '手机麦克风已停止，正在确认 Mac 恢复');
    if (restart) {
      await render().toggle();
      assert.equal(render().state, 'speaking');
    }
    settle(); await stopping;
    assert.equal(render().state, restart ? 'speaking' : 'idle');
    assert.equal(render().message, restart ? '手机麦克风传输中' : fail ? 'late failure' : '手机麦克风已停止');
  }
});
