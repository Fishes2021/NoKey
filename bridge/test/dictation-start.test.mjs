import { normalizeDictation } from '../../desktop/dictation-settings.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createKeyboardController } from '../lib/keyboard-api.mjs';
import { handleVoiceRequest } from '../lib/voice-api.mjs';
const source = readFileSync(new URL('../../desktop/voice-host.mjs', import.meta.url), 'utf8');
const pcm = source.slice(source.indexOf('  const pcm ='), source.indexOf('  const clear =')) + '\nglobalThis.deliver = pcm;';
test('Mac starts once on first PCM using the app-selected input; stopped sessions cannot trigger keys', () => {
  let starts = 0;
  const session = { id: 'audio', startDictation: () => { starts++; return { status: 200, body: JSON.stringify({ posted: true }) }; } };
  const c = { active: session, Float32Array, trusted: () => true, output: { push: () => 0 },
    microphone: { snapshot: () => ({ devices: [{ selected: true, uid: 'VoiceDeckMicrophone_UID' }] }) }, dispose: () => assert.fail('unexpected disposal') };
  vm.runInNewContext(pcm, c);
  const frame = { sessionId: 'audio', samples: new Float32Array(960), gain: 1 };
  c.deliver({}, frame); c.deliver({}, frame); assert.equal(starts, 1); assert.equal(session.dictationLinked, true);
  c.active = null; c.deliver({}, frame); assert.equal(starts, 1);
  c.active = { id: 'audio', startDictation: () => assert.fail('wrong input must not trigger dictation') };
  c.microphone.snapshot = () => ({ devices: [] }); c.deliver({}, frame); assert.equal(c.active.inputReady, false);
});
test('voice offer carries only a validated lease; delayed activation retains keyboard target, expiry and enable checks', async () => {
  let now = 0, sent = 0, target = { id: 'editor', name: 'Editor' }, activate;
  const keys = createKeyboardController({ snapshot: () => JSON.stringify({ trusted: true, target }),
    press: () => { sent++; return JSON.stringify({ posted: true, target }); } }, { now: () => now });
  keys.setEnabled(true);
  const context = { material: { keyId: 'paired-phone' }, payload: { method: 'POST', path: '/api/keyboard/target', body: {} } };
  const leaseId = JSON.parse(keys.handle(context).body).leaseId;
  context.payload = { method: 'POST', path: '/api/voice/offer', body: { description: { type: 'offer', sdp: 'offer' }, dictationLeaseId: leaseId } };
  const host = { offer: async (_owner, _description, start) => { activate = start; return { dictationManaged: Boolean(start) }; } };
  const start = id => keys.handle({ ...context, payload: { method: 'POST', path: '/api/keyboard/press', body: { leaseId: id, operationId: 'unique_operation_1234', key: 'RightOption', modifiers: [] } } });
  assert.equal((await handleVoiceRequest(context, host, start)).status, 200); assert.equal(sent, 0);
  target = { id: 'other', name: 'Other' }; assert.equal(activate().status, 409); assert.equal(sent, 0);
  keys.setEnabled(false); assert.equal(activate().status, 503);
  context.payload.body.dictationLeaseId = '../invalid'; assert.equal((await handleVoiceRequest(context, host, start)).status, 400);
});

const releaseCode = source.slice(source.indexOf('  const release ='), source.indexOf('  const reply =')) + '\nglobalThis.releaseSession = release;';
test('session cleanup uses frozen shortcut once, checks focus, and preserves stop receipt', () => {
  let posts = [];
  const c = { active: { id: 'session', owner: 'phone', dictationManaged: true, dictationTarget: 'editor', dictationSettings: { key: 'Space', modifiers: ['control', 'option'], sendDelayMs: 800 } },
    lastStop: null, KEY_CODES: { Space: 49 }, MODIFIER_FLAGS: { control: 1 << 18, option: 1 << 19 },
    keyboard: { snapshot: () => JSON.stringify({ trusted: true, target: { id: 'editor' } }), press: (...args) => { posts.push(args); return JSON.stringify({ posted: true, target: { id: 'editor' } }); } },
    output: { clear() {}, close() {} }, recoveryWork: null };
  vm.runInNewContext(releaseCode, c);
  assert.equal(c.releaseSession().dictationStopped, true); c.releaseSession();
  assert.equal(posts.length, 1); assert.equal(posts[0][1], 49); assert.equal(posts[0][2], (1 << 18) | (1 << 19));
  assert.equal(c.lastStop.result.sendDelayMs, 800); assert.equal(c.lastStop.owner, 'phone');
  c.active = { id: 'new', owner: 'phone', dictationManaged: true, dictationTarget: 'different', dictationSettings: {} };
  assert.equal(c.releaseSession().dictationStopped, false); assert.equal(posts.length, 1);
});

test('offer freezes configuration; disconnect and explicit stop share one owner-scoped receipt', async () => {
  const settings = { key: 'Space', modifiers: ['control'], sendDelayMs: 900 };
  let posts = 0;
  const c = { active: null, closed: false, lastStop: null, recoveryWork: null, normalizeDictation, getDictationSettings: () => settings,
    getIceConfig: async () => ({ iceServers: [] }), request: async () => ({ sessionId: 'one' }), fail: message => Error(message),
    trusted: () => true, Float32Array, dispose() { assert.fail(); },
    microphone: { snapshot: () => ({ devices: [{ selected: true, uid: 'VoiceDeckMicrophone_UID' }] }) },
    output: { open: () => 0, push: () => 0, clear() {}, close() {} }, KEY_CODES: { Space: 49 }, MODIFIER_FLAGS: { control: 1 << 18 },
    keyboard: { snapshot: () => JSON.stringify({trusted:true,target:{id:'editor'}}), press: (_target,key,flags) => { posts++; assert.equal(key,49); assert.equal(flags,1<<18); return JSON.stringify({posted:true,target:{id:'editor'}}); } } };
  const methods = source.slice(source.indexOf('    async offer('), source.indexOf('    revoke(owner)'));
  vm.runInNewContext(releaseCode + pcm + '\nglobalThis.host = {' + methods + '};', c);
  await c.host.offer('phone', {}, shortcut => { assert.equal(shortcut.key, 'Space'); return {status:200,body:JSON.stringify({posted:true,target:{id:'editor'}})}; });
  settings.key = 'RightOption'; settings.sendDelayMs = 50;
  c.deliver({}, {sessionId:'one',samples:new Float32Array(960),gain:1});
  c.releaseSession(); // Receiver disconnect arrives first.
  assert.equal((await c.host.control('stop','phone',{sessionId:'one'})).sendDelayMs,900);
  assert.equal((await c.host.control('stop','phone',{sessionId:'one'})).dictationStopped,true);
  await assert.rejects(c.host.control('stop','other-phone',{sessionId:'one'}));
  assert.equal(posts,1);
});
