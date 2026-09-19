import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { bridgeRequest, resetBridgeRoute, currentBridgeRoute } from '@/lib/bridge';
import type { E2EEKeyMaterial } from '@/lib/e2ee-core';
import { randomE2EEId } from '@/lib/e2ee';
import { normalizeShortcut, type KeyboardShortcut } from '@/lib/keyboard-shortcuts.mjs';

type Target = { id: string; name: string; bundleId: string };
type TargetReply = { enabled: boolean; trusted: boolean; target: Target | null; leaseId?: string; validForMs?: number };
type Lease = { identity: string; target: Target; leaseId: string; expires: number };

export function useGenericKeyboard(url: string, token: string, e2ee: E2EEKeyMaterial | null, enabled: boolean) {
  const [connection, setConnection] = useState<'checking' | 'online' | 'offline' | 'unauthorized' | 'subscription'>('checking');
  const [lease, setLease] = useState<Lease | null>(null);
  const [message, setMessage] = useState('连接 Mac 后可使用通用快捷键');
  const [result, setResult] = useState('');
  const [busy, setBusy] = useState(false);
  // Identity changes invalidate callbacks immediately, before effect cleanup.
  const identity = `${url}:${token}:${e2ee?.keyId ?? ''}:${enabled}`;
  const current = useRef(identity); current.current = identity;
  const validLease = useRef<Lease | null>(null);
  const sending = useRef(false);

  useEffect(() => {
    let disposed = false;
    let generation = 0;
    let failures = 0;
    let rejected = false;
    let request: AbortController | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    validLease.current = null; setLease(null); setResult('');
    setMessage('连接 Mac 后可使用通用快捷键');
    const poll = async () => {
      if (disposed || rejected || AppState.currentState !== 'active') return;
      const run = ++generation;
      request = new AbortController();
      let retry = true;
      const started = performance.now();
      try {
        const state = await bridgeRequest<TargetReply>(url, token, '/api/keyboard/target', { method: 'POST', timeoutMs: 2000, signal: request.signal }, e2ee);
        if (disposed || run !== generation || current.current !== identity) return;
        failures = 0; setConnection('online');
        // Count network time against the lease; never extend it on response arrival.
        const next = state.enabled && state.trusted && state.target?.id && state.target.name &&
          state.leaseId && typeof state.validForMs === 'number' && state.validForMs > 0 && state.validForMs <= 3000
          ? { identity, target: state.target, leaseId: state.leaseId, expires: started + state.validForMs } : null;
        validLease.current = next && next.expires > performance.now() ? next : null;
        setLease(validLease.current);
        setMessage(!state.enabled ? '请在 Mac 客户端启用通用快捷键'
          : !state.trusted ? '请在 Mac 客户端设置辅助功能权限'
          : validLease.current ? `按键目标：${state.target!.name}` : '暂无可用的前台应用，正在刷新');
      } catch (error) {
        if (disposed || run !== generation || current.current !== identity) return;
        failures++;
        const auth = error instanceof Error && error.name === 'BridgeAuthError';
        const subscription = ['RELAY_SUBSCRIPTION_REQUIRED', 'RELAY_INACTIVE'].includes((error as { code?: string })?.code || '');
        retry = !auth; rejected = auth;
        setConnection(auth ? 'unauthorized' : subscription ? 'subscription' : (error as { code?: string })?.code === 'MAC_OFFLINE' ? 'offline' : 'checking');
        validLease.current = null; setLease(null);
        setMessage(error instanceof Error ? error.message : '无法读取 Mac 按键目标');
      } finally {
        if (!disposed && retry && run === generation && current.current === identity && AppState.currentState === 'active')
          timer = setTimeout(poll, failures ? Math.min(15000, 1000 * 2 ** Math.min(failures, 4)) : 1000);
      }
    };
    const update = () => {
      generation++; clearTimeout(timer); request?.abort(); validLease.current = null; setLease(null);
      setConnection(rejected ? 'unauthorized' : 'checking'); failures = 0;
      resetBridgeRoute(e2ee, AppState.currentState === 'active');
      if (enabled && e2ee && AppState.currentState === 'active') void poll();
    };
    update();
    const subscription = AppState.addEventListener('change', update);
    return () => { resetBridgeRoute(e2ee, false); disposed = true; generation++; clearTimeout(timer); request?.abort(); subscription.remove(); validLease.current = null; };
  }, [url, token, e2ee, enabled, identity]);

  const press = useCallback(async (shortcut: KeyboardShortcut | string, continuous = false) => {
    const target = validLease.current;
    if (sending.current) return false;
    if (!enabled || !e2ee || current.current !== identity || AppState.currentState !== 'active' ||
        !target || target.identity !== identity || target !== lease || target.expires <= performance.now()) {
      setResult(`未发送：${message}；请就绪后再点击`); return false;
    }
    sending.current = true;
    if (!continuous) { setBusy(true); setResult('正在发送按键'); }
    try {
      const textInput = typeof shortcut === 'string';
      if (textInput && (!shortcut.trim() || shortcut.length > 2000)) throw new Error('请输入 1–2000 字');
      const normalized = textInput ? { text: shortcut } : normalizeShortcut(shortcut);
      const operationId = await randomE2EEId();
      if (current.current !== identity || AppState.currentState !== 'active' || target.expires <= performance.now()) {
        throw new Error('目标已过期，按键未发送');
      }
      const reply = await bridgeRequest<{ operationId: string; posted: boolean; target: Target; message: string }>(
        url, token, textInput ? '/api/keyboard/text' : '/api/keyboard/press', { method: 'POST', timeoutMs: 2000,
          body: { ...normalized, operationId, leaseId: target.leaseId } }, e2ee);
      if (reply.operationId !== operationId || reply.posted !== true || reply.target?.id !== target.target.id) throw new Error('按键回执无效');
      if (current.current === identity) setResult(continuous ? '' : `${target.target.name}：${reply.message}`);
      return true;
    } catch (error) {
      if (current.current === identity) setResult(`${error instanceof Error ? error.message : '结果未确认'}；不会自动重发`);
      return false;
    } finally {
      sending.current = false; if (!continuous) setBusy(false);
    }
  }, [url, token, e2ee, enabled, identity, lease, message]);

  const pressNow = useRef(press); pressNow.current = press;
  const movement = useRef({ steps: 0, running: false, identity: '', target: '' });
  const moveCursor = useCallback((delta: -1 | 1, steps: number) => {
    const target = validLease.current;
    if (!Number.isInteger(steps) || steps < 1 || !target || target.identity !== identity) return;
    const queue = movement.current;
    if (queue.running && (queue.identity !== identity || queue.target !== target.target.id)) return;
    queue.identity = identity; queue.target = target.target.id;
    // ponytail: cap pending movement at 32; a native batch API is needed for faster sustained spinning.
    queue.steps = Math.max(-32, Math.min(32, queue.steps + delta * steps));
    if (queue.running) return;
    queue.running = true;
    void (async () => {
      try {
        while (queue.steps && current.current === identity && AppState.currentState === 'active') {
          if (validLease.current?.target.id !== queue.target) break;
          if (!sending.current) {
            const direction = Math.sign(queue.steps);
            queue.steps -= direction;
            if (!await pressNow.current({ key: direction > 0 ? 'ArrowRight' : 'ArrowLeft', modifiers: [] }, true)) break;
          }
          await new Promise(resolve => setTimeout(resolve, 70));
        }
      } finally { queue.steps = 0; queue.running = false; }
    })();
  }, [identity]);

  return { connection, transport: currentBridgeRoute(e2ee)?.startsWith('https:') ? 'relay' : 'local', dictationLeaseId: enabled && lease?.identity === identity && lease.expires > performance.now() ? lease.leaseId : undefined, target: enabled && lease?.identity === identity ? lease.target : null, message, result, busy, press, moveCursor };
}
