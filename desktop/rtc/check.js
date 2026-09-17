import { VoiceReceiver } from './receiver.js';
import { VoiceSender } from '../../mobile/lib/voice-sender.mjs';
const assert = (ok, message) => { if (!ok) throw new Error(message); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let receiver, sender, audio, oscillator;
try {
  const configuration = await window.voiceCheck.configuration();
  let blocks = 0, sound = false, clears = 0, deliveredGain = null;
  receiver = new VoiceReceiver({ ...configuration, onPCM(samples, gain) {
    deliveredGain = gain;
    assert(samples.length === 960 && samples.every(Number.isFinite), 'PCM format');
    blocks++; sound ||= samples.some(x => Math.abs(x) > 0.05);
  }, onClear() { clears++; } });
  assert(receiver.receptionStatus().state === 'idle', 'initial receiver idle');
  const viewOnly = new VoiceReceiver({ onPCM() {} });
  for (const [state, expected] of [['connecting', 'connecting'], ['disconnected', 'interrupted'], ['failed', 'interrupted']]) {
    viewOnly.active = { state, peakAt: Date.now(), peak: 1 };
    assert(viewOnly.receptionStatus().state === expected && viewOnly.receptionStatus().peak === null, 'non-connected state cannot show audio level');
  }
  for (let round = 0; round < 3; round++) {
    sound = false;
    const initial = configuration.configs?.[round] || { iceServers: [], expiresAt: null };
    const renewed = configuration.configs?.[round + 1] || initial;
    receiver.iceServers = initial.iceServers;
    audio = new AudioContext({ sampleRate: 48000, sinkId: { type: 'none' } });
    oscillator = audio.createOscillator();
    const destination = audio.createMediaStreamDestination();
    oscillator.connect(destination); oscillator.connect(audio.destination);
    oscillator.start(); await audio.resume();
    let receipt = false, useRenewed = false;
    sender = new VoiceSender({
      gain: 0.5,
      onStats: stats => { receipt ||= stats.received === true; },
      getIceConfig: async () => useRenewed ? renewed : initial,
      createPeer: options => new RTCPeerConnection({ ...options, iceTransportPolicy: configuration.iceTransportPolicy || 'all' }),
      getStream: async () => destination.stream,
      request: async (path, body) => {
        if (path.endsWith('/offer')) {
          const pending = receiver.offer('paired-phone', body.description);
          let occupied = false;
          try { await receiver.offer('other-phone', body.description); } catch (e) { occupied = e.statusCode === 409; }
          assert(occupied, 'single session reservation');
          return pending;
        }
        if (path.endsWith('/restart')) return receiver.restart('paired-phone', body.sessionId, body.description, renewed.iceServers);
        if (path.endsWith('/gain')) return receiver.gain('paired-phone', body.sessionId, body.gain);
        if (path.endsWith('/status')) return receiver.status('paired-phone', body.sessionId);
        return receiver.stop('paired-phone', body.sessionId);
      },
    });
    await sender.start();
    const answer = { sessionId: receiver.active.id };
    for (let i = 0; !sound && i < 200; i++) await sleep(20);
    const energy = [...(await sender.current.pc.getStats()).values(), ...(await receiver.active.pc.getStats()).values()]
      .filter(s => ['media-source', 'inbound-rtp'].includes(s.type))
      .map(s => ({ type: s.type, energy: s.totalAudioEnergy, level: s.audioLevel, samples: s.totalSamplesReceived }));
    assert(sound && blocks > 0, `real decoded audio: ${receiver.lastError}; ${JSON.stringify(receiver.status('paired-phone', answer.sessionId))}; energy=${JSON.stringify(energy)}; source=${audio.state}; sink=${receiver.active.audio.state}`);
    assert(receiver.receptionStatus().state === 'receiving', 'decoded PCM drives received state');
    assert(receiver.status('paired-phone', answer.sessionId).receiving === true, 'phone status reports fresh PCM');
    const peakAt = receiver.active.peakAt;
    receiver.active.peakAt = Date.now() - 501;
    assert(receiver.status('paired-phone', answer.sessionId).receiving === false, 'phone status rejects stale PCM');
    receiver.active.peakAt = peakAt;
    assert(receiver.receptionStatus(receiver.active.peakAt + 501).state === 'waiting', 'stale PCM cannot show receiving');
    let denied = false;
    try { await receiver.stop('other-phone', answer.sessionId); } catch (e) { denied = e.statusCode === 404; }
    assert(denied, 'owner required');
    assert(deliveredGain === 0.5, 'saved gain reaches the PCM output');
    assert(receiver.status('paired-phone', answer.sessionId).peak > 0, 'real PCM peak is reported');
    await sender.setGain(4);
    for (let i = 0; receiver.status('paired-phone', answer.sessionId).peak < 1 && i < 100; i++) await sleep(20);
    assert(deliveredGain === 4 && receiver.status('paired-phone', answer.sessionId).peak > 1, 'gain overload is measured before clipping');
    await sender.setGain(0);
    for (let i = 0; deliveredGain !== 0 && i < 100; i++) await sleep(20);
    assert(deliveredGain === 0 && receiver.status('paired-phone', answer.sessionId).peak === 0, 'zero gain is applied and reported');
    await sender.setGain(0.5);
    assert(receiver.status('paired-phone', answer.sessionId).lastAudioAt, 'network receipt');
    for (let i = 0; !receipt && i < 150; i++) await sleep(20);
    assert(receipt, 'phone receives actual Mac audio progress');
    const selectedPair = async pc => {
      const stats = await pc.getStats();
      const transport = [...stats.values()].find(report => report.type === 'transport' && report.selectedCandidatePairId);
      const pair = stats.get(transport?.selectedCandidatePairId);
      return pair ? { ...pair, localUfrag: stats.get(pair.localCandidateId)?.usernameFragment, localPort: stats.get(pair.localCandidateId)?.port } : undefined;
    };
    const oldPairs = configuration.iceTransportPolicy === 'relay'
      ? await Promise.all([sender.current.pc, receiver.active.pc].map(selectedPair)) : [];
    const priorFrames = receiver.active.frames;
    const priorStream = sender.current.stream;
    const priorId = receiver.active.id;
    const oldUfrag = sender.current.pc.localDescription.sdp.match(/a=ice-ufrag:(.+)/)?.[1];
    useRenewed = true;
    await sender.restart();
    for (let i = 0; receiver.active?.frames <= priorFrames && i < 150; i++) await sleep(20);
    assert(receiver.active?.id === priorId && receiver.active.frames > priorFrames, 'same session receives audio after ICE restart');
    assert(sender.current.stream === priorStream, 'restart reuses the microphone stream');
    assert(sender.current.pc.localDescription.sdp.match(/a=ice-ufrag:(.+)/)?.[1] !== oldUfrag, 'ICE generation changes');
    if (configuration.iceTransportPolicy === 'relay') {
      // ICE restart returns before both transports have nominated their new pair.
      // Wait for matching relay allocations, not merely another PCM frame on the old route.
      let routes = [];
      for (let attempt = 0; attempt < 150; attempt++) {
        routes = await Promise.all([sender.current.pc, receiver.active.pc].map(async pc => {
          const stats = await pc.getStats();
          const transport = [...stats.values()].find(report => report.type === 'transport' && report.selectedCandidatePairId);
          const pair = stats.get(transport?.selectedCandidatePairId);
          return { local: stats.get(pair?.localCandidateId), remote: stats.get(pair?.remoteCandidateId) };
        }));
        if (routes.every((route, index) => route.local?.candidateType === 'relay' && route.local.port !== oldPairs[index]?.localPort) &&
            routes[0].remote?.port === routes[1].local?.port && routes[1].remote?.port === routes[0].local?.port) break;
        await sleep(20);
      }
      for (const [index, pc] of [sender.current.pc, receiver.active.pc].entries()) {
        const stats = await pc.getStats();
        const transport = [...stats.values()].find(report => report.type === 'transport' && report.selectedCandidatePairId);
        const pair = stats.get(transport?.selectedCandidatePairId);
        assert(pair && stats.get(pair.localCandidateId)?.candidateType === 'relay', 'selected local route must be TURN relay');
        const local = stats.get(pair.localCandidateId), remote = stats.get(pair.remoteCandidateId);
        const advertised = pc.localDescription.sdp.split('\r\n').filter(line => line.startsWith('a=candidate:') && line.includes(' typ relay '));
        assert(advertised.some(line => Number(line.split(' ')[5]) !== oldPairs[index]?.localPort),
          `renewal allocation missing: side=${index} advertised=${JSON.stringify(advertised)} state=${pc.iceGatheringState} old=${oldPairs[index]?.localPort}`);
        assert(local.port !== oldPairs[index]?.localPort, 'new relay allocation must be selected after renewal');
      }
      // During restart Chromium can classify a discovered remote TURN address as
      // prflx. Match it to the OTHER endpoint's actual selected relay allocation.
      assert(routes[0].remote.port === routes[1].local.port && routes[1].remote.port === routes[0].local.port,
        'each remote candidate must target the other endpoint TURN allocation');
    }
    if (round === 0 && configuration.credentialExpiresAt) {
      await sleep(Math.max(0, configuration.credentialExpiresAt + 1200 - Date.now()));
      assert(Date.now() > configuration.credentialExpiresAt, 'old TURN credentials actually expired');
    }
    const renewedFrames = receiver.active.frames;
    for (let i = 0; receiver.active.frames <= renewedFrames && i < 100; i++) await sleep(20);
    assert(receiver.active.frames > renewedFrames, 'audio continues after the renewed route is selected');
    if (round === 2) {
      sender.interrupt('test system interruption');
      assert(sender.current === null && destination.stream.getTracks().every(track => track.readyState === 'ended'), 'interruption releases capture immediately');
      for (let i = 0; receiver.active && i < 100; i++) await sleep(20);
    } else await sender.stop();
    const before = blocks; await sleep(100);
    assert(blocks === before && receiver.active === null, 'stop clears audio and ownership');
    assert(receiver.receptionStatus().state === 'idle' && receiver.receptionStatus().peak === null, 'stop clears visible status and level');
    oscillator.stop(); destination.stream.getTracks().forEach(track => track.stop());
    await audio.close();
  }
  assert(clears === 3, 'every session cleared');
  await receiver.close();
  window.voiceCheck.done({ ok: true, blocks, rounds: 3, relay: configuration.iceTransportPolicy === 'relay' });
} catch (error) {
  await sender?.stop().catch(() => {}); await receiver?.close();
  if (audio && audio.state !== 'closed') await audio.close();
  window.voiceCheck.done({ ok: false, error: error.stack });
}
