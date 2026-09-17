import test from 'node:test';
import assert from 'node:assert/strict';
import { VoiceSender } from '../../mobile/lib/voice-sender.mjs';
import { setImmediate } from 'node:timers/promises';

async function gatherDescription(pc, description) {
  pc.localDescription = description;
  pc.iceGatheringState = 'gathering'; pc.onicegatheringstatechange?.();
  pc.iceGatheringState = 'complete'; pc.onicegatheringstatechange?.();
}

test('stop during permission acquisition releases late microphone without opening a peer', async () => {
  let grant, stopped = false;
  const sender = new VoiceSender({
    getStream: () => new Promise(resolve => { grant = resolve; }),
    createPeer: () => { throw new Error('must not connect after stop'); },
    request: () => { throw new Error('must not signal'); },
  });
  const pending = sender.start();
  await setImmediate();
  await sender.stop();
  grant({ getTracks: () => [{ stop() { stopped = true; } }] });
  await pending;
  assert(stopped && sender.current === null);
});

test('stop releases capture immediately and cleans a late offer answer without reconnecting', async () => {
  let answer, stopped = false, closed = false, applied = false;
  const requests = [];
  const track = { stop() { stopped = true; } };
  const pc = { iceGatheringState: 'complete', getTransceivers: () => [], addTrack() {},
    createOffer: async () => ({ type: 'offer', sdp: 'test' }),
    setLocalDescription: description => gatherDescription(pc, description),
    setRemoteDescription: async () => { applied = true; }, close() { closed = true; } };
  const sender = new VoiceSender({ createPeer: () => pc,
    getStream: async () => ({ getTracks: () => [track], getAudioTracks: () => [track] }),
    request: async (path, body) => {
      requests.push({ path, body });
      if (path.endsWith('/offer')) return new Promise(resolve => { answer = resolve; });
      return { stopped: true };
    } });
  const pending = sender.start(); await setImmediate();
  assert(answer);
  await sender.stop();
  assert(stopped && closed && !applied);
  answer({ sessionId: 'late-session', description: { type: 'answer', sdp: 'late' } });
  await pending;
  assert(!applied && sender.current === null);
  assert.deepEqual(requests.at(-1), { path: '/api/voice/stop', body: { sessionId: 'late-session' } });
});

test('receipt monitoring distinguishes real frames and stops capture on revoked authorization', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let revoked = false, stopped = false, frames = 480, receiving = true;
  const telemetry = [], states = [];
  const track = { stop() { stopped = true; } };
  const pc = { iceGatheringState: 'complete', connectionState: 'connected', getTransceivers: () => [], addTrack() {},
    createOffer: async () => ({ type: 'offer', sdp: 'test' }),
    setLocalDescription: value => gatherDescription(pc, value),
    setRemoteDescription: async () => {}, close() {},
    getStats: async () => new Map([['mic', { type: 'media-source', kind: 'audio', audioLevel: 0.25 }]]) };
  const sender = new VoiceSender({ createPeer: () => pc,
    getStream: async () => ({ getTracks: () => [track], getAudioTracks: () => [track] }),
    onStats: value => telemetry.push(value), onState: (...args) => states.push(args),
    request: async path => {
      if (path.endsWith('/offer')) return { sessionId: 'audio', description: {} };
      if (path.endsWith('/status')) {
        if (revoked) throw Object.assign(new Error('revoked'), { name: 'BridgeAuthError' });
        return { sessionId: 'audio', frames, receiving, peak: 1.2, inputSelected: true, inputError: '' };
      }
      return {};
    } });
  await sender.start(); await setImmediate();
  assert.deepEqual(telemetry.at(-1), { received: true, level: 0.25, peak: 1.2, inputSelected: true, inputError: '' });
  t.mock.timers.tick(1000); await setImmediate();
  assert.equal(telemetry.at(-1).received, false);
  frames += 480; receiving = false;
  t.mock.timers.tick(1000); await setImmediate();
  assert.equal(telemetry.at(-1).received, false, 'old buffered frames are not current reception');
  assert.equal(telemetry.at(-1).peak, null);
  frames += 480; receiving = undefined;
  t.mock.timers.tick(1000); await setImmediate();
  assert.equal(telemetry.at(-1).received, null, 'older Mac without freshness reporting stays unknown');
  revoked = true;
  t.mock.timers.tick(1000); await setImmediate();
  assert(stopped && sender.current === null);
  assert.equal(states.at(-1)[0], 'error');
  assert.match(states.at(-1)[1], /重新扫码/);
});

test('stalled receipt request times out capture and cannot resurrect a stopped session', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let reply, stopped = false;
  const telemetry = [];
  const track = { stop() { stopped = true; } };
  const pc = { iceGatheringState: 'complete', connectionState: 'connected', getTransceivers: () => [], addTrack() {},
    createOffer: async () => ({ type: 'offer', sdp: 'test' }),
    setLocalDescription: value => gatherDescription(pc, value), setRemoteDescription: async () => {}, close() {} };
  const sender = new VoiceSender({ createPeer: () => pc,
    getStream: async () => ({ getTracks: () => [track], getAudioTracks: () => [track] }),
    onStats: value => telemetry.push(value),
    request: async path => path.endsWith('/offer') ? { sessionId: 'audio', description: {} }
      : path.endsWith('/status') ? new Promise(resolve => { reply = resolve; }) : {} });
  await sender.start();
  t.mock.timers.tick(10000);
  assert(stopped && sender.current === null);
  reply({ sessionId: 'audio', frames: 480 }); await setImmediate();
  assert.deepEqual(telemetry.at(-1), { received: null, level: null, peak: null });
});

test('scheduled credential renewal keeps capture; stop cancels a pending renewal', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1800000000000 });
  let streams = 0, restarts = 0, stopped = false, delayed, delayConfig = false, configurations = 0;
  const track = { stop() { stopped = true; } };
  const pc = { iceGatheringState: 'complete', connectionState: 'connected', getTransceivers: () => [], addTrack() {},
    setConfiguration(config) { pc.config = config; },
    createOffer: async options => { if (options?.iceRestart) restarts++; return { type: 'offer', sdp: 'test' }; },
    setLocalDescription: value => gatherDescription(pc, value), setRemoteDescription: async () => {}, close() {} };
  const sender = new VoiceSender({ createPeer: () => pc,
    getIceConfig: async () => {
      configurations++;
      const config = { iceServers: [{ urls: 'turn:test', credential: String(configurations) }],
        expiresAt: Date.now() + (configurations === 1 ? 241000 : 3600000) };
      if (delayConfig) return new Promise(resolve => { delayed = () => resolve(config); });
      return config;
    },
    getStream: async () => { streams++; return { getTracks: () => [track], getAudioTracks: () => [track] }; },
    request: async path => path.endsWith('/offer') || path.endsWith('/restart') ? { sessionId: 'audio', description: {} }
      : path.endsWith('/status') ? { sessionId: 'audio', frames: 480 } : {} });
  await sender.start(); await setImmediate();
  t.mock.timers.tick(1000); await setImmediate();
  assert.equal(restarts, 1); assert.equal(streams, 1); assert(!stopped);
  assert.equal(pc.config.iceServers[0].credential, '2');
  delayConfig = true;
  const pending = sender.restart(); await setImmediate();
  await sender.stop(); delayed(); await pending;
  assert(stopped && sender.current === null);
  assert.equal(restarts, 1);
});

test('previous complete state cannot finish a new ICE gathering cycle', async () => {
  let signals = 0, descriptions = 0;
  const track = { stop() {} };
  const pc = { iceGatheringState: 'complete', connectionState: 'connected', getTransceivers: () => [], addTrack() {},
    createOffer: async () => ({ type: 'offer', sdp: 'test' }),
    setLocalDescription: async value => { pc.localDescription = value; descriptions++; },
    setRemoteDescription: async () => {}, close() {} };
  const sender = new VoiceSender({ createPeer: () => pc,
    getStream: async () => ({ getTracks: () => [track], getAudioTracks: () => [track] }),
    request: async path => {
      if (path.endsWith('/offer')) { signals++; return { sessionId: 'audio', description: {} }; }
      return { sessionId: 'audio', frames: 0 };
    } });
  const starting = sender.start(); await setImmediate();
  assert.equal(descriptions, 1); assert.equal(signals, 0);
  pc.onicegatheringstatechange(); // Stale complete event alone is insufficient.
  await setImmediate(); assert.equal(signals, 0);
  pc.iceGatheringState = 'gathering'; pc.onicegatheringstatechange();
  pc.iceGatheringState = 'complete'; pc.onicegatheringstatechange();
  await starting;
  assert.equal(signals, 1);
  await sender.stop();
});


test('saved gain applies before media, live gain requires acknowledgement and late replies do not alter a stopped session', async () => {
  let applied = 1, remote = false, reply, delayed = false;
  const track = { stop() {} };
  const pc = { iceGatheringState: 'complete', connectionState: 'connected', getTransceivers: () => [], addTrack() {},
    createOffer: async () => ({ type: 'offer', sdp: 'test' }),
    setLocalDescription: value => gatherDescription(pc, value),
    setRemoteDescription: async () => { assert.equal(applied, 0.5); remote = true; }, close() {} };
  const sender = new VoiceSender({ gain: 0.5, createPeer: () => pc,
    getStream: async () => ({ getTracks: () => [track], getAudioTracks: () => [track] }),
    request: async (path, body) => {
      if (path.endsWith('/offer')) return { sessionId: 'audio', description: {} };
      if (path.endsWith('/gain')) {
        if (delayed) return new Promise(resolve => { reply = resolve; });
        applied = body.gain;
        return { sessionId: body.sessionId, gain: applied };
      }
      return { sessionId: 'audio', frames: 0 };
    } });
  await sender.start(); assert(remote);
  await sender.setGain(0); assert.equal(sender.gain, 0); assert.equal(applied, 0);
  for (const invalid of [-1, 4.1, NaN, Infinity, '1']) await assert.rejects(sender.setGain(invalid), /范围/);
  delayed = true;
  const pending = sender.setGain(2);
  await assert.rejects(sender.setGain(3), /尚未完成/);
  reply({ sessionId: 'other', gain: 2 });
  await assert.rejects(pending, /未确认/); assert.equal(sender.gain, 0);
  const late = sender.setGain(1);
  await sender.stop(); reply({ sessionId: 'audio', gain: 1 });
  await assert.rejects(late, /已结束/); assert.equal(sender.gain, 0);
});

test('responsive status without fresh PCM cannot keep capture alive; fresh silence can', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const mode of ['stagnant', 'stale', 'silence']) {
    let frames = 0, stopped = false;
    const states = [];
    const track = { stop() { stopped = true; } };
    const pc = { iceGatheringState: 'complete', connectionState: 'connected', getTransceivers: () => [], addTrack() {},
      createOffer: async () => ({ type: 'offer', sdp: 'test' }),
      setLocalDescription: value => gatherDescription(pc, value), setRemoteDescription: async () => {}, close() {} };
    const sender = new VoiceSender({ createPeer: () => pc,
      getStream: async () => ({ getTracks: () => [track], getAudioTracks: () => [track] }),
      onState: (...args) => states.push(args),
      request: async path => {
        if (path.endsWith('/offer')) return { sessionId: 'audio', description: {} };
        if (path.endsWith('/status')) return { sessionId: 'audio', frames: mode === 'stagnant' ? 480 : (frames += 480), receiving: mode !== 'stale', peak: 0 };
        return {};
      } });
    try {
      await sender.start(); await setImmediate();
      for (let second = 0; second < 11; second++) { t.mock.timers.tick(1000); await setImmediate(); }
      assert.equal(stopped, mode !== 'silence', mode);
      if (mode !== 'silence') assert.match(states.at(-1)[1], /10 秒/);
    } finally { await sender.stop(); }
  }
});

test('startup checks readiness after 200ms, then returns to 1s polling and cancels on stop', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let polls = 0;
  const sender = new VoiceSender({ createPeer() {}, getStream() {}, request: async () => {
    polls++;
    return { sessionId: 'startup', frames: polls * 960, receiving: true, inputSelected: polls > 1 };
  } });
  const session = sender.current = { id: 'startup', frames: 0, pc: { close() {} } };
  sender.monitor(session); await setImmediate();
  assert.equal(polls, 1);
  t.mock.timers.tick(199); await setImmediate(); assert.equal(polls, 1);
  t.mock.timers.tick(1); await setImmediate(); assert.equal(polls, 2);
  t.mock.timers.tick(999); await setImmediate(); assert.equal(polls, 2);
  t.mock.timers.tick(1); await setImmediate(); assert.equal(polls, 3);
  await sender.stop(); const stoppedAt = polls;
  t.mock.timers.tick(1000); await setImmediate(); assert.equal(polls, stoppedAt);
});

test('network change restarts ICE using still-valid credentials without recapturing or changing session', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let captures = 0, restarts = 0, stopped = 0;
  const config = { iceServers: [], expiresAt: Date.now() + 3600000 };
  const track = { stop() { stopped++; } };
  const pc = { connectionState: 'connected', getTransceivers: () => [], addTrack() {}, close() {}, setConfiguration() {},
    createOffer: async options => { if (options?.iceRestart) restarts++; return { type: 'offer', sdp: 'test' }; },
    setLocalDescription: value => gatherDescription(pc, value),
    setRemoteDescription: async () => { pc.connectionState = 'connected'; pc.onconnectionstatechange?.(); } };
  const sender = new VoiceSender({ getIceConfig: async () => config, createPeer: () => pc,
    getStream: async () => { captures++; return { getTracks: () => [track], getAudioTracks: () => [track] }; },
    request: async (path, body) => {
      if (path.endsWith('/offer') || path.endsWith('/restart')) {
        if (path.endsWith('/restart')) assert.equal(body.sessionId, 'same-session');
        return { sessionId: 'same-session', description: {} };
      }
      return { sessionId: 'same-session', frames: 480, receiving: true, inputSelected: true };
    } });
  await sender.start();
  pc.connectionState = 'disconnected'; pc.onconnectionstatechange();
  t.mock.timers.tick(800); await setImmediate();
  assert.equal(restarts, 1); assert.equal(captures, 1); assert.equal(stopped, 0);
  assert.equal(sender.current.id, 'same-session');
  pc.connectionState = 'disconnected'; pc.onconnectionstatechange();
  await sender.stop(); t.mock.timers.tick(800); await setImmediate();
  assert.equal(restarts, 1, 'explicit stop cancels network recovery'); assert.equal(stopped, 1);
});
