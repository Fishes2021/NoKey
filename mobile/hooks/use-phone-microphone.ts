import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Platform } from 'react-native';
import { VoiceSender, type VoiceTelemetry, type VoiceState } from '../lib/voice-sender.mjs';
import { createPhoneAudioCapture } from '../lib/phone-audio-capture.mjs';
import { validateIceConfig } from '../lib/ice-config.mjs';
import { bridgeRequest } from '../lib/bridge';
import { readStoredValue, writeStoredValue } from '../lib/storage';
import type { E2EEKeyMaterial } from '../lib/e2ee-core';

export function usePhoneMicrophone(bridgeUrl: string, token: string, encryption: E2EEKeyMaterial | null) {
  const [state, setState] = useState<VoiceState>('idle');
  const [message, setMessage] = useState('');
  const [telemetry, setTelemetry] = useState<VoiceTelemetry>({ received: null, level: null, peak: null });
  const preferenceKey = encryption ? `voicedeck.gain.${encryption.keyId}` : '';
  const [preference, setPreference] = useState({ key: '', gain: 1 });
  const [gainBusy, setGainBusy] = useState(false);
  const gainLock = useRef(false);
  const [gainMessage, setGainMessage] = useState('');
  const gainReady = Boolean(preferenceKey && preference.key === preferenceKey);
  const gain = gainReady ? preference.gain : 1;
  useEffect(() => {
    let cancelled = false;
    setGainMessage('');
    if (preferenceKey) void readStoredValue(preferenceKey).then(value => {
      const saved = value === null ? 1 : Number(value);
      if (!cancelled) setPreference({ key: preferenceKey, gain: Number.isFinite(saved) && saved >= 0 && saved <= 4 ? saved : 1 });
    }).catch(() => {
      if (!cancelled) { setPreference({ key: preferenceKey, gain: 1 }); setGainMessage('无法读取保存的音量，暂用 100%'); }
    });
    return () => { cancelled = true; };
  }, [preferenceKey]);
  const sender = useRef<VoiceSender | null>(null);
  const generation = useRef(0);
  const starting = useRef(false);
  const requests = useRef<AbortController | null>(null);
  useEffect(() => {
    setState('idle'); setMessage(''); setTelemetry({ received: null, level: null, peak: null });
    return () => {
      generation.current++;
      requests.current?.abort();
      starting.current = false;
      const previous = sender.current;
      sender.current = null;
      void previous?.stop().catch(() => {});
    };
  }, [bridgeUrl, token, encryption]);
  const changeGain = useCallback(async (value: number) => {
    if (!gainReady || gainLock.current || starting.current || !Number.isFinite(value) || value < 0 || value > 4) return;
    const currentGeneration = generation.current;
    gainLock.current = true; setGainBusy(true); setGainMessage('');
    let applied = false;
    try {
      if (sender.current) await sender.current.setGain(value);
      if (generation.current !== currentGeneration) return;
      applied = true;
      setPreference({ key: preferenceKey, gain: value });
      await writeStoredValue(preferenceKey, String(value));
      if (generation.current === currentGeneration) setGainMessage('音量已保存');
    } catch {
      if (generation.current === currentGeneration) setGainMessage(applied ? '音量已调整，但未能保存；下次可能恢复旧设置' : 'Mac 未确认调整，显示上次确认的音量，请重试');
    } finally { gainLock.current = false; setGainBusy(false); }
  }, [gainReady, preferenceKey]);
  const stop = useCallback(async () => {
    const stoppedGeneration = ++generation.current;
    requests.current?.abort();
    const previous = sender.current; sender.current = null;
    starting.current = false;
    setState('idle'); setMessage('手机麦克风已停止，正在确认 Mac 恢复');
    try {
      const result = await previous?.stop();
      if (generation.current === stoppedGeneration) setMessage(result?.dictationError || '手机麦克风已停止');
      return result;
    } catch (error) {
      if (generation.current === stoppedGeneration) setMessage(error instanceof Error ? error.message : '手机已停止；Mac 恢复未确认');
    }
  }, []);
  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => {
      if (state !== 'active' && (sender.current || starting.current)) void stop();
    });
    return () => subscription.remove();
  }, [stop]);
  const toggle = useCallback(async (dictationLeaseId?: string) => {
    if (sender.current || starting.current) { await stop(); return; }
    if (AppState.currentState !== 'active') return;
    if (!encryption || !token) { setMessage('请先与 Mac 加密配对'); return; }
    if (!gainReady || gainLock.current) { setMessage('请等待音量设置加载或保存'); return; }
    if (Platform.OS !== 'ios') { setMessage('实时手机麦克风目前仅支持 iPhone 安装版'); return; }
    const currentGeneration = ++generation.current;
    const abort = new AbortController(); requests.current = abort;
    starting.current = true;
    setTelemetry({ received: null, level: null, peak: null });
    setState('connecting'); setMessage('正在连接手机麦克风');
    let capture: { stop(): void } | undefined;
    try {
      const [rtc, { default: nativeAudio }] = await Promise.all([import('react-native-webrtc'), import('../modules/voicedeck-audio')]);
      if (generation.current !== currentGeneration) return;
      let current: VoiceSender | null = null;
      const guardedCapture = createPhoneAudioCapture(nativeAudio,
        () => rtc.mediaDevices.getUserMedia({ audio: true, video: false }),
        reason => { if (generation.current === currentGeneration) current?.interrupt(reason); });
      capture = guardedCapture;
      current = new VoiceSender({
        dictationLeaseId, gain,
        stopCapture: guardedCapture.stop,
        getIceConfig: async () => validateIceConfig(await bridgeRequest(bridgeUrl, token, '/api/voice/config', { method: 'POST', body: {}, signal: abort.signal }, encryption)),
        createPeer: configuration => new rtc.RTCPeerConnection(configuration),
        getStream: guardedCapture.getStream,
        request: (path, body) => bridgeRequest(bridgeUrl, token, path, { method: 'POST', body, signal: path === '/api/voice/stop' ? undefined : abort.signal, timeoutMs: path === '/api/voice/stop' ? 3000 : undefined }, encryption),
        onStats: stats => { if (generation.current === currentGeneration) setTelemetry(stats); },
        onState: (next, error) => {
          if (generation.current !== currentGeneration) return;
          setState(next);
          setMessage(error || ({ idle: '手机麦克风已停止', connecting: '正在连接',
            speaking: '手机麦克风传输中', reconnecting: '连接中断，正在恢复', error: '麦克风连接失败' }[next]));
          if (next === 'idle' || next === 'error') { sender.current = null; starting.current = false; }
        },
      });
      sender.current = current;
      await current.start();
    } catch (error) {
      try { capture?.stop(); } catch { /* Track teardown is also handled by VoiceSender. */ }
      if (generation.current !== currentGeneration) return;
      sender.current = null; setState('error');
      setMessage(error instanceof Error ? error.message : '手机麦克风启动失败');
    } finally {
      if (generation.current === currentGeneration) starting.current = false;
    }
  }, [bridgeUrl, token, encryption, gainReady, gain, stop]);
  return { state, message, telemetry, toggle, stop, gain, gainMessage, changeGain, gainBusy: gainBusy || !gainReady || state === 'connecting' || state === 'reconnecting', active: ['connecting', 'speaking', 'reconnecting'].includes(state) };
}
