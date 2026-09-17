// SPDX-License-Identifier: GPL-3.0-only
const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });

async function gather(pc, description) {
  let gathering = false;
  await new Promise((resolve, reject) => {
    const finish = (error) => {
      clearTimeout(timer);
      pc.removeEventListener('icegatheringstatechange', changed);
      pc.removeEventListener('connectionstatechange', closed);
      error ? reject(error) : resolve();
    };
    const changed = () => {
      if (pc.iceGatheringState === 'gathering') gathering = true;
      if (gathering && pc.iceGatheringState === 'complete') finish();
    };
    const closed = () => { if (pc.connectionState === 'closed') finish(fail('会话已关闭', 409)); };
    const timer = setTimeout(() => finish(fail('连接候选收集超时', 504)), 8000);
    pc.addEventListener('icegatheringstatechange', changed);
    pc.addEventListener('connectionstatechange', closed);
    pc.setLocalDescription(description).catch(finish);
  });
}

function validateOffer(description) {
    if (description?.type !== 'offer' || typeof description.sdp !== 'string')
      throw fail('需要音频 offer');
    const media = description.sdp.match(/^m=.*$/gm);
    if (
        description.sdp.length > 24000 || media?.length !== 1 || !media[0].startsWith('m=audio '))
      throw fail('需要仅包含单个音频轨的 offer');
}

// Runs in the sandboxed local Electron renderer. Owner must come from the
// authenticated main-process signaling bridge, never from arbitrary web content.
export class VoiceReceiver {
  constructor({ iceServers = [], iceTransportPolicy = 'all', onPCM, onClear = () => {}, onClosed = () => {} } = {}) {
    this.iceServers = iceServers;
    this.iceTransportPolicy = iceTransportPolicy;
    this.onPCM = onPCM;
    this.onClear = onClear;
    this.onClosed = onClosed;
    this.active = null;
    this.lastError = null;
  }
  receptionStatus(now = Date.now()) {
    const s = this.active;
    if (!s || s.closing) return { state: 'idle', peak: null };
    if (['disconnected', 'failed', 'closed'].includes(s.state)) return { state: 'interrupted', peak: null };
    if (s.state !== 'connected') return { state: 'connecting', peak: null };
    // Network bytes alone do not prove decoded PCM reached the output callback.
    if (!s.peakAt || now - s.peakAt > 500) return { state: 'waiting', peak: null };
    return { state: 'receiving', peak: s.peak };
  }
  async offer(owner, description) {
    if (typeof owner !== 'string' || !owner) throw fail('需要已认证设备身份', 401);
    if (this.active) throw fail('麦克风已被占用', 409);
    validateOffer(description);
    const s = { id: crypto.randomUUID(), owner, state: 'connecting', gain: 1,
      peak: null, peakWindowAt: 0, peakAt: 0, frames: 0, lastAudioAt: null, pc: null, audio: null, worklet: null, source: null,
      timeout: null, statsTimer: null, receivedBytes: 0, closing: false, playback: null };
    this.active = s;
    this.lastError = null;
    try {
      s.audio = new AudioContext({ sampleRate: 48000, sinkId: { type: 'none' } });
      await s.audio.audioWorklet.addModule(new URL('./pcm-worklet.js', import.meta.url));
      if (this.active !== s) throw fail('会话已关闭', 409);
      s.worklet = new AudioWorkletNode(s.audio, 'voice-pcm', { outputChannelCount: [2] });
      s.worklet.connect(s.audio.destination);
      s.worklet.port.onmessage = ({ data }) => {
        if (this.active !== s || s.state !== 'connected' || !s.lastAudioAt || Date.now() - s.lastAudioAt > 500) return;
        if (!(data instanceof Float32Array) || data.length !== 960 || !data.every(Number.isFinite)) {
          this.lastError = '音频数据格式异常'; void this.closeSession(s); return;
        }
        const now = Date.now();
        if (now - s.peakWindowAt >= 1000) { s.peak = 0; s.peakWindowAt = now; }
        for (const sample of data) s.peak = Math.max(s.peak ?? 0, Math.abs(sample) * s.gain);
        s.peakAt = now;
        try { this.onPCM(data, s.gain, s.id); s.frames += data.length / 2; }
        catch (error) { this.lastError = error.message; void this.closeSession(s); }
      };
      const pc = s.pc = new RTCPeerConnection({ iceServers: this.iceServers, iceTransportPolicy: this.iceTransportPolicy });
      s.timeout = setTimeout(() => void this.closeSession(s), 15000);
      pc.ontrack = ({ track }) => {
        if (track.kind !== 'audio' || s.source) { void this.closeSession(s); return; }
        const stream = new MediaStream([track]);
        // Start the remote track's playout; Web Audio alone can leave Chromium's
        // remote decoder idle. This element is muted before receiving any media.
        s.playback = new Audio();
        s.playback.muted = true;
        s.playback.srcObject = stream;
        s.playback.play().catch(error => { this.lastError = error.message; void this.closeSession(s); });
        s.source = s.audio.createMediaStreamSource(stream);
        s.source.connect(s.worklet);
        track.onended = () => void this.closeSession(s);
      };
      pc.onconnectionstatechange = () => {
        if (this.active !== s) return;
        s.state = pc.connectionState;
        if (s.state === 'connected') { clearTimeout(s.timeout); s.timeout = null; }
        else if (s.state === 'disconnected') {
          this.onClear(s.id);
          s.lastAudioAt = null;
          if (!s.timeout) s.timeout = setTimeout(() => void this.closeSession(s), 10000);
        } else if (['closed', 'failed'].includes(s.state)) void this.closeSession(s);
      };
      await pc.setRemoteDescription(description);
      const opus = RTCRtpReceiver.getCapabilities('audio').codecs.filter(c => c.mimeType.toLowerCase() === 'audio/opus');
      if (!opus.length) throw fail('Opus 不可用', 503);
      for (const transceiver of pc.getTransceivers()) {
        transceiver.direction = 'recvonly'; transceiver.setCodecPreferences(opus);
      }
      await gather(pc, await pc.createAnswer());
      await s.audio.resume();
      if (this.active !== s) throw fail('会话已关闭', 409);
      // Decoder silence is not evidence of incoming network audio.
      let checking = false;
      s.statsTimer = setInterval(async () => {
        if (checking || this.active !== s) return;
        checking = true;
        try {
          const stats = await pc.getStats();
          if (this.active !== s) return;
          for (const stat of stats.values()) if (stat.type === 'inbound-rtp' && stat.kind === 'audio') {
            if (stat.bytesReceived > s.receivedBytes) s.lastAudioAt = Date.now();
            s.receivedBytes = stat.bytesReceived;
          }
        } catch { if (this.active === s) void this.closeSession(s); }
        finally { checking = false; }
      }, 100);
      return { sessionId: s.id, description: pc.localDescription.toJSON() };
    } catch (error) { await this.closeSession(s); throw error; }
  }
  async restart(owner, id, description, iceServers) {
    const s = this.session(owner, id);
    if (s.restarting) throw fail('连接续期正在进行', 409);
    validateOffer(description);
    s.restarting = true;
    try {
      s.pc.setConfiguration({ iceServers, iceTransportPolicy: this.iceTransportPolicy });
      await s.pc.setRemoteDescription(description);
      await gather(s.pc, await s.pc.createAnswer());
      this.session(owner, id);
      return { sessionId: id, description: s.pc.localDescription.toJSON() };
    } catch (error) { await this.closeSession(s); throw error; }
    finally { s.restarting = false; }
  }
  session(owner, id) {
    if (!this.active || this.active.owner !== owner || this.active.id !== id || this.active.closing)
      throw fail('语音会话不存在或未授权', 404);
    return this.active;
  }
  status(owner, id) {
    const s = this.session(owner, id);
    const reception = this.receptionStatus();
    return { sessionId: s.id, state: s.state, frames: s.frames, lastAudioAt: s.lastAudioAt, gain: s.gain, receiving: reception.state === 'receiving', peak: reception.peak };
  }
  gain(owner, id, value) {
    const s = this.session(owner, id);
    if (!Number.isFinite(value) || value < 0 || value > 4) throw fail('音量范围为 0–4');
    s.gain = value; s.peak = null; s.peakAt = 0; s.peakWindowAt = 0; return this.status(owner, id);
  }
  async stop(owner, id) { await this.closeSession(this.session(owner, id)); return { stopped: true }; }
  async closeSession(s) {
    if (this.active !== s || s.closing) return;
    s.closing = true;
    s.state = 'closed';
    clearTimeout(s.timeout); clearInterval(s.statsTimer);
    if (s.worklet) { s.worklet.port.onmessage = null; s.worklet.disconnect(); s.worklet.port.close(); }
    s.source?.disconnect();
    if (s.playback) { s.playback.pause(); s.playback.srcObject = null; }
    if (s.pc) {
      s.pc.ontrack = null; s.pc.onconnectionstatechange = null;
      for (const receiver of s.pc.getReceivers()) { receiver.track.onended = null; receiver.track.stop(); }
      s.pc.close();
    }
    try {
      try { this.onClear(s.id); }
      finally { if (s.audio && s.audio.state !== 'closed') await s.audio.close(); }
    } finally { if (this.active === s) this.active = null; this.onClosed(s.id); }
  }
  async close() { if (this.active) await this.closeSession(this.active); }
}
