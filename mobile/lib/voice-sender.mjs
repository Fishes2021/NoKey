// SPDX-License-Identifier: GPL-3.0-only
// Shared by the React Native adapter and the real browser transport check.
export class VoiceSender {
  constructor({ dictationLeaseId, createPeer, getStream, stopCapture = () => {}, request, onState = () => {}, onStats = () => {}, iceServers = [], gain = 1, getIceConfig = async () => ({ iceServers, expiresAt: null }) }) {
    Object.assign(this, { dictationLeaseId, createPeer, getStream, stopCapture, request, onState, onStats, iceServers, getIceConfig });
    if (!Number.isFinite(gain) || gain < 0 || gain > 4) throw new Error('音量范围为 0–4');
    this.gain = gain;
    this.gainPending = false;
    this.current = null;
  }
  async start() {
    if (this.current) return;
    const s = { pc: null, stream: null, id: null, timer: null, recovery: null, poll: null, watchdog: null, frames: 0, cancelGather: null, renewal: null, expiry: null, restarting: null, config: null };
    this.current = s;
    this.onState('connecting');
    try {
      const config = s.config = await this.getIceConfig();
      if (this.current !== s) return;
      const stream = await this.getStream();
      if (this.current !== s) { stream.getTracks().forEach(t => t.stop()); stream.release?.(); return; }
      s.stream = stream;
      const pc = s.pc = this.createPeer({ iceServers: config.iceServers });
      for (const track of stream.getAudioTracks()) {
        track.onended = () => { if (this.current === s) void this.stop().catch(() => {}); };
        pc.addTrack(track, stream);
      }
      pc.onconnectionstatechange = () => {
        if (this.current !== s) return;
        if (pc.connectionState === 'connected') {
          clearTimeout(s.timer); clearTimeout(s.recovery); s.recovery = null; s.timer = null; this.onState('speaking');
        } else if (pc.connectionState === 'disconnected') {
          this.onState('reconnecting');
          if (s.id && !s.recovery && !s.restarting) s.recovery = setTimeout(() => {
            s.recovery = null;
            if (this.current === s && pc.connectionState === 'disconnected')
              void this.restart({ renewCredentials: false }).catch(() => {});
          }, 800);
          if (!s.timer) s.timer = setTimeout(() => void this.stop().catch(() => {}), 10000);
        } else if (['failed', 'closed'].includes(pc.connectionState)) {
          void this.stop().catch(() => {});
        }
      };
      // sendonly keeps the phone from accepting remote audio playback.
      for (const transceiver of pc.getTransceivers()) transceiver.direction = 'sendonly';
      await this.negotiate(s, false);
      if (this.current === s) {
        if (pc.connectionState !== 'connected') s.timer = setTimeout(() => void this.stop().catch(() => {}), 10000);
        this.monitor(s);
        this.scheduleRenewal(s);
      }
    } catch (error) {
      if (this.current === s) {
        await this.stop().catch(() => {});
        this.onState('error', error.message);
        throw error;
      }
    }
  }
  async negotiate(s, restart) {
    const pc = s.pc;
      const description = await pc.createOffer(restart ? { iceRestart: true } : undefined);
      await new Promise((resolve, reject) => {
        let gathering = false;
        const done = error => {
          clearTimeout(timer); pc.onicegatheringstatechange = null; s.cancelGather = null;
          error ? reject(error) : resolve();
        };
        const timer = setTimeout(() => done(new Error('连接候选收集超时')), 8000);
        s.cancelGather = () => done(new Error('已停止讲话'));
        pc.onicegatheringstatechange = () => {
          if (pc.iceGatheringState === 'gathering') gathering = true;
          if (gathering && pc.iceGatheringState === 'complete') done();
        };
        pc.setLocalDescription(description).catch(done);
      });
      if (this.current !== s) return;
      const answer = await this.request(restart ? '/api/voice/restart' : '/api/voice/offer', {
        ...(restart ? { sessionId: s.id } : this.dictationLeaseId ? { dictationLeaseId: this.dictationLeaseId } : {}),
        description: { type: pc.localDescription.type, sdp: pc.localDescription.sdp },
      });
      if (restart && answer.sessionId !== s.id) throw new Error('续期返回了不同的语音会话');
      s.id = answer.sessionId;
      if (!restart) s.dictationManaged = answer.dictationManaged === true;
      if (this.current !== s) { await this.request('/api/voice/stop', { sessionId: s.id }); return; }
      // Apply the saved gain before allowing the new media connection to start.
      if (!restart && this.gain !== 1) await this.setGain(this.gain);
      if (this.current === s) await pc.setRemoteDescription(answer.description);
  }
  async setGain(value) {
    if (!Number.isFinite(value) || value < 0 || value > 4) throw new Error('音量范围为 0–4');
    const s = this.current;
    if (!s?.id || this.gainPending) throw new Error('连接或音量调整尚未完成');
    this.gainPending = true;
    try {
      const result = await this.request('/api/voice/gain', { sessionId: s.id, gain: value });
      if (this.current !== s) throw new Error('语音会话已结束');
      if (result.sessionId !== s.id || result.gain !== value) throw new Error('Mac 未确认音量设置');
      this.gain = value;
    } finally { this.gainPending = false; }
  }
  scheduleRenewal(s) {
    clearTimeout(s.renewal); clearTimeout(s.expiry);
    if (!Number.isFinite(s.config.expiresAt)) return;
    s.expiry = setTimeout(() => {
      if (this.current !== s) return;
      void this.stop().catch(() => {});
      this.onState('error', '中继凭据未能及时续期，已停止采音');
    }, Math.max(0, s.config.expiresAt - Date.now() - 30000));
    s.renewal = setTimeout(() => void this.restart().catch(() => {}),
      Math.max(1000, s.config.expiresAt - Date.now() - 240000));
  }
  async restart({ renewCredentials = true } = {}) {
    const s = this.current;
    if (!s?.id) return;
    if (s.restarting) return s.restarting;
    s.restarting = (async () => {
      try {
        const config = await this.getIceConfig();
        if (this.current !== s) return;
        if (renewCredentials && Number.isFinite(s.config.expiresAt) && (!Number.isFinite(config.expiresAt) || config.expiresAt <= s.config.expiresAt))
          throw new Error('中继服务未提供新的有效凭据');
        s.pc.setConfiguration({ ...s.pc.getConfiguration?.(), iceServers: config.iceServers });
        await this.negotiate(s, true);
        if (this.current !== s) return;
        s.config = config;
        this.scheduleRenewal(s);
      } catch (error) {
        if (this.current === s) {
          void this.stop().catch(() => {});
          this.onState('error', `连接续期失败，已停止采音：${error.message}`);
        }
        throw error;
      } finally { s.restarting = null; }
    })();
    return s.restarting;
  }
  monitor(s) {
    const fail = message => {
      if (this.current !== s) return;
      void this.stop().catch(() => {});
      this.onState('error', message);
    };
    const arm = () => {
      clearTimeout(s.watchdog);
      s.watchdog = setTimeout(() => fail('Mac 超过 10 秒未确认新音频，已停止采音，请检查连接或更新 Mac 客户端后重试'), 10000);
    };
    arm();
    const poll = async () => {
      if (this.current !== s) return;
      let pollDelay = 1000;
      try {
        const status = await this.request('/api/voice/status', { sessionId: s.id });
        if (this.current !== s) return;
        if (status.sessionId !== s.id || !Number.isFinite(status.frames) || status.frames < 0)
          throw new Error('Mac 返回了无效的收音状态');
        // Confirm startup promptly; return to the quiet cadence once ready or failed.
        pollDelay = status.inputSelected || status.inputError ? 1000 : 200;
        // A larger counter may describe audio received before the connection stalled.
        const received = typeof status.receiving === 'boolean' ? status.receiving && status.frames > s.frames : null;
        if (received) arm();
        s.frames = status.frames;
        let level = null;
        try {
          const stats = await s.pc.getStats?.();
          stats?.forEach(report => {
            if (report.type === 'media-source' && report.kind === 'audio' && Number.isFinite(report.audioLevel))
              level = Math.max(0, Math.min(1, report.audioLevel));
          });
        } catch { /* Level is optional; unknown must not look like zero input. */ }
        if (this.current === s) this.onStats({ received, level, ...(s.dictationManaged ? { dictationManaged: true, dictationLinked: status.dictationLinked === true, dictationError: status.dictationError || '' } : {}), inputSelected: status.inputSelected === true, inputError: typeof status.inputError === 'string' ? status.inputError : '', peak: received && Number.isFinite(status.peak) && status.peak >= 0 ? status.peak : null });
      } catch (error) {
        if (this.current !== s) return;
        this.onStats({ received: null, level: null, peak: null });
        if (error.name === 'BridgeAuthError' || error.statusCode === 401) {
          fail('Mac 已拒绝此手机的授权，采音已停止，请重新扫码配对');
          return;
        }
        if (error.statusCode === 404) { fail('Mac 已结束语音会话，请重新开始讲话'); return; }
      }
      if (this.current === s) s.poll = setTimeout(poll, pollDelay);
    };
    void poll();
  }
  interrupt(message = '系统音频已中断，恢复后请点开始讲话') {
    if (!this.current) return;
    void this.stop().catch(() => {});
    this.onState('error', message);
  }
  async stop() {
    const s = this.current;
    if (!s) return;
    this.current = null;
    clearTimeout(s.timer); clearTimeout(s.recovery); clearTimeout(s.poll); clearTimeout(s.watchdog); clearTimeout(s.renewal); clearTimeout(s.expiry); s.cancelGather?.();
    let captureError;
    try { this.stopCapture(); } catch (error) { captureError = error; }
    this.onStats({ received: null, level: null, peak: null });
    if (s.stream) {
      s.stream.getTracks().forEach(track => { track.onended = null; track.stop(); });
      s.stream.release?.();
    }
    if (s.pc) { s.pc.onconnectionstatechange = null; s.pc.close(); }
    this.onState('idle'); // Phone capture ends before any network request.
    try {
      if (s.id) {
        const reply = await this.request('/api/voice/stop', { sessionId: s.id });
        if (reply?.microphone?.recovery && reply?.microphoneHeld !== true) throw new Error(reply.microphone.message || '原麦克风尚未恢复，请在 Mac 点击恢复');
        return reply;
      }
    }
    finally { if (captureError) throw captureError; }
  }
}
