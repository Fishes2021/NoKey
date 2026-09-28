// Run later with: node --test bridge/test/shortcut-recorder.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { recordedShortcut } from '../../desktop/shortcut-recorder.mjs';
import { normalizeDictation } from '../../desktop/dictation-settings.mjs';

test('physical key recording and saved modifier-only dictation shortcuts', () => {
  for (const [event, expected] of [
    [{ code: 'AltRight', altKey: true }, { key: 'RightOption', modifiers: [] }],
    [{ code: 'AltLeft', altKey: true, metaKey: true }, { key: 'LeftOption', modifiers: ['LeftCommand'] }],
    [{ code: 'MetaLeft', metaKey: true, altKey: true }, { key: 'LeftCommand', modifiers: ['LeftOption'] }],
    [{ code: 'Space', ctrlKey: true, altKey: true }, { key: 'Space', modifiers: ['LeftControl', 'LeftOption'] }],
    [{ code: 'KeyA', key: 'å', altKey: true }, { key: 'A', modifiers: ['LeftOption'] }],
    [{ code: 'Digit0' }, { key: '0', modifiers: [] }],
    [{ code: 'Quote' }, { key: "'", modifiers: [] }],
    [{ code: 'Escape' }, { key: 'Escape', modifiers: [] }],
  ]) {
    assert.deepEqual(recordedShortcut(event, ['MetaLeft', 'ControlLeft', 'AltLeft', 'ShiftLeft']), expected);
    assert.deepEqual(normalizeDictation({ ...expected, sendDelayMs: 350 }), { ...expected, sendDelayMs: 350 });
  }
  for (const code of ['Fn', 'CapsLock', 'NumpadEnter', 'Unidentified', 'constructor'])
    assert.throws(() => recordedShortcut({ code }));
  for (const modifiers of [['option'], ['command', 'command'], ['fn'], ['bad']])
    assert.throws(() => normalizeDictation({ key: 'RightOption', modifiers, sendDelayMs: 350 }));
});

test('right Shift survives either recording order and validation', () => {
  const first = recordedShortcut({ code: 'MetaRight', metaKey: true, shiftKey: true }, ['ShiftRight']);
  const second = recordedShortcut({ code: 'ShiftRight', metaKey: true, shiftKey: true }, ['MetaRight']);
  assert.deepEqual(first, { key: 'RightCommand', modifiers: ['RightShift'] });
  assert.deepEqual(second, { key: 'RightShift', modifiers: ['RightCommand'] });
  assert.deepEqual(normalizeDictation({ ...first, sendDelayMs: 350 }), { ...first, sendDelayMs: 350 });
  assert.throws(() => recordedShortcut({ code: 'KeyA', metaKey: true }, []));
  for (const modifiers of [['shift', 'RightShift'], ['LeftShift', 'RightShift'], ['RightCommand']])
    assert.throws(() => normalizeDictation({ key: 'RightCommand', modifiers, sendDelayMs: 350 }));
});

test('renderer saves on release and exposes retry on failure without launching app', async () => {
  const { readFile } = await import('node:fs/promises');
  const { runInNewContext } = await import('node:vm');
  const source = await readFile(new URL('../../desktop/rtc/engine.js', import.meta.url), 'utf8');
  const nodes = new Map(), listeners = {}, calls = [];
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { value: '350', hidden: true, listeners: {},
      addEventListener(type, fn) { this.listeners[type] = fn; }, focus() {} });
    return nodes.get(id);
  };
  let fail = false;
  runInNewContext(source.slice(source.indexOf('let desktopState'), source.indexOf('const renderExpiry')), {
    document: { getElementById: node, hasFocus: () => true, addEventListener() {} },
    window: { addEventListener: (type, fn) => { listeners[type] = fn; }, desktopClient: {
      action: async (action, value) => {
        if (action !== 'dictation-save') return;
        calls.push(JSON.parse(JSON.stringify(value)));
        if (fail) throw Error('模拟写入失败');
        return {};
      },
    } }, recordedShortcut, keyboardKeyLabel: key => key, renderDesktop() {},
  });
  const key = (code, extra = {}) => ({ code, preventDefault() {}, stopImmediatePropagation() {}, ...extra });
  const record = async () => {
    await node('dictation-record').listeners.click();
    listeners.keydown(key('ShiftRight', { shiftKey: true }));
    listeners.keydown(key('MetaRight', { shiftKey: true, metaKey: true }));
    listeners.keyup(key('MetaRight', { shiftKey: true }));
    listeners.keyup(key('ShiftRight'));
    await new Promise(resolve => setImmediate(resolve));
  };
  await record();
  assert.deepEqual(calls[0], { key: 'RightCommand', modifiers: ['RightShift'], sendDelayMs: 350 });
  assert.match(node('dictation-status').textContent, /^已保存/);
  assert.equal(node('dictation-save').hidden, true);
  fail = true;
  await record();
  assert.match(node('dictation-status').textContent, /^未保存/);
  assert.equal(node('dictation-save').hidden, false);
  fail = false;
  node('dictation-form').listeners.submit({ preventDefault() {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.match(node('dictation-status').textContent, /^已保存/);
});
