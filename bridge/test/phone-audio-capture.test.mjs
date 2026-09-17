import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { createPhoneAudioCapture } from '../../mobile/lib/phone-audio-capture.mjs';
import { VoiceSender } from '../../mobile/lib/voice-sender.mjs';

// Only the OS binding is simulated; the adapter and VoiceSender are production code.
function nativeGate() {
  let serial = 0, armed = null;
  const listeners = new Set(), log = [];
  return { log, listeners,
    addListener(name, callback) { assert.equal(name, 'interrupted'); listeners.add(callback); return { remove() { listeners.delete(callback); } }; },
    arm() { armed = String(++serial); log.push('arm'); return armed; },
    activate(id) { log.push('activate'); return armed === id; },
    stop(id) { if (id === armed) { armed = null; log.push('native-stop'); } },
    // Simulate native cancellation before event delivery (e.g. suspended JS).
    interrupt(deliver = true) {
      const captureId = armed; armed = null; log.push('native-interruption');
      const event = { captureId, reason: 'system' };
      if (deliver) for (const listener of listeners) listener(event);
      return event;
    },
  };
}
function media(log) {
  const track = { stop() { log.push('track-stop'); } };
  return { getTracks: () => [track], getAudioTracks: () => [track], release() { log.push('stream-release'); } };
}

test('system interruption during permission acquisition cannot start a late microphone', async () => {
  for (const delivered of [true, false]) {
    const native = nativeGate();
    let grant, sender, peers = 0;
    const capture = createPhoneAudioCapture(native, () => new Promise(resolve => { grant = resolve; }), reason => sender.interrupt(reason));
    sender = new VoiceSender({ getStream: capture.getStream, stopCapture: capture.stop,
      createPeer: () => { peers++; throw new Error('unexpected peer'); }, request: () => { throw new Error('unexpected network request'); } });
    const pending = sender.start(); await setImmediate();
    native.interrupt(delivered);
    grant(media(native.log));
    if (delivered) await pending;
    else await assert.rejects(pending, /系统音频已中断/);
    assert.equal(sender.current, null);
    assert.equal(peers, 0);
    assert(native.log.includes('track-stop') && native.log.includes('stream-release'));
    assert.equal(native.listeners.size, 0);
  }
});

test('stop cancels native capture while permission is pending; a stale event cannot stop a new capture', async () => {
  const native = nativeGate();
  let grant, interruptions = 0;
  const first = createPhoneAudioCapture(native, () => new Promise(resolve => { grant = resolve; }), () => interruptions++);
  const oldListener = [...native.listeners][0];
  const pending = first.getStream();
  first.stop();
  grant(media(native.log)); await assert.rejects(pending, /取消/);
  const second = createPhoneAudioCapture(native, async () => media(native.log), () => interruptions++);
  const acquired = await second.getStream();
  oldListener({ captureId: '1', reason: 'system' });
  for (const listener of native.listeners) listener({ captureId: '1', reason: 'system' });
  first.stop();
  assert.equal(interruptions, 0); assert.equal(native.listeners.size, 1);
  second.stop(); acquired.getTracks().forEach(track => track.stop()); acquired.release();
  assert.equal(native.listeners.size, 0);
});

test('active interruption releases native audio and tracks before awaiting the Mac; no automatic resume', async () => {
  const native = nativeGate(), states = [];
  let sender, reply, streams = 0;
  const stream = media(native.log);
  const pc = { connectionState: 'connected', addTrack() {}, getTransceivers: () => [],
    createOffer: async () => ({ type: 'offer', sdp: 'test' }),
    setLocalDescription: async value => {
      pc.localDescription = value;
      pc.iceGatheringState = 'gathering'; pc.onicegatheringstatechange();
      pc.iceGatheringState = 'complete'; pc.onicegatheringstatechange();
    }, setRemoteDescription: async () => {}, close() { native.log.push('peer-close'); } };
  const capture = createPhoneAudioCapture(native, async () => { streams++; return stream; }, reason => sender.interrupt(reason));
  sender = new VoiceSender({ getStream: capture.getStream, stopCapture: capture.stop, createPeer: () => pc,
    onState: (...args) => states.push(args), request: async path => {
      if (path.endsWith('/offer')) return { sessionId: 'audio', description: {} };
      if (path.endsWith('/stop')) { native.log.push('mac-stop'); return new Promise(resolve => { reply = resolve; }); }
      return { sessionId: 'audio', frames: 0 };
    } });
  await sender.start();
  native.interrupt();
  assert.equal(sender.current, null);
  assert.equal(states.at(-1)[0], 'error'); assert.match(states.at(-1)[1], /恢复后请点/);
  assert(native.log.indexOf('native-interruption') < native.log.indexOf('track-stop'));
  assert(native.log.indexOf('stream-release') < native.log.indexOf('mac-stop'));
  assert.equal(native.listeners.size, 0);
  reply({ stopped: true }); await setImmediate();
  assert.equal(streams, 1); assert.equal(sender.current, null);
});
