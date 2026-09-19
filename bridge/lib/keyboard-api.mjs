// SPDX-License-Identifier: GPL-3.0-only
import { randomUUID } from 'node:crypto';
import { KEY_CODES, MODIFIER_FLAGS, normalizeShortcut } from '../../mobile/lib/keyboard-shortcuts.mjs';
const reply = (status, body) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(value);

// Native calls are synchronous: no request queue or await between checking the target and posting.
// Caller must revalidate the E2EE context immediately before handle().
export function createKeyboardController(native, { now = () => performance.now(), onPosted = () => {} } = {}) {
  let enabled = false;
  const leases = new Map(), outcomes = new Map(), rates = new Map();
  const prune = time => {
    for (const [id, entry] of leases) if (entry.expires <= time) leases.delete(id);
    for (const [id, entry] of outcomes) if (entry.expires <= time) outcomes.delete(id);
    for (const [id, entry] of rates) if (entry.until <= time) rates.delete(id);
  };
  return {
    setEnabled(value) {
      if (typeof value !== 'boolean') throw new Error('快捷键开关无效');
      enabled = value;
      leases.clear();
      return { enabled, trusted: native ? JSON.parse(native.snapshot()).trusted : false };
    },
    revoke(owner) {
      for (const [id, lease] of leases) if (lease.owner === owner) leases.delete(id);
      // Outcomes stay until expiry; revocation must not enable duplicate execution.
      rates.delete(owner);
    },
    handle(context) {
      const payload = context?.payload;
      if (typeof payload?.path !== 'string' || !payload.path.startsWith('/api/keyboard/')) return null;
      const owner = context.material?.keyId;
      if (!owner) return reply(401, { error: '需要已授权的手机身份' });
      if (payload.method !== 'POST') return reply(405, { error: '快捷键接口需要 POST' });
      if (!['/api/keyboard/target', '/api/keyboard/press', '/api/keyboard/text'].includes(payload.path)) return reply(404, { error: '未知快捷键接口' });
      if (!native) return reply(503, { error: '请启动包含快捷键组件的 Mac 客户端' });
      const time = now(); prune(time);
      if (payload.path.endsWith('/target')) {
        const state = JSON.parse(native.snapshot());
        if (!enabled || !state.trusted || !state.target) return reply(200, { enabled, trusted: state.trusted, target: null });
        if (leases.size >= 128) return reply(429, { error: '目标刷新过于频繁，请稍后重试' });
        const leaseId = randomUUID();
        leases.set(leaseId, { owner, target: state.target, expires: time + 3000 });
        return reply(200, { enabled, trusted: true, target: state.target, leaseId, validForMs: 3000 });
      }
      if (!enabled) return reply(503, { error: '请先在 Mac 启用通用快捷键' });
      const body = payload.body;
      if (!body || !validId(body.operationId) || !validId(body.leaseId)) return reply(400, { error: '快捷键请求标识无效' });
      const textInput = payload.path.endsWith('/text');
      let shortcut;
      try {
        if (textInput && (typeof body.text !== 'string' || !body.text.trim() || body.text.length > 2000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(body.text))) throw new Error('文字须为 1–2000 字，不能包含控制字符');
        shortcut = textInput ? { text: body.text, modifiers: [] } : normalizeShortcut(body);
      } catch (error) { return reply(400, { error: error.message }); }
      const id = `${owner}:${body.operationId}`;
      const fingerprint = JSON.stringify([body.leaseId, shortcut]);
      const previous = outcomes.get(id);
      if (previous) return previous.fingerprint === fingerprint ? previous.result : reply(409, { error: '同一请求标识不能用于不同操作' });
      const lease = leases.get(body.leaseId);
      if (!lease || lease.owner !== owner) return reply(409, { error: '操作目标已过期，请刷新后主动重试', posted: false });
      const rate = rates.get(owner) || { count: 0, until: time + 1000 };
      if (rate.count >= 20 || outcomes.size >= 1024) return reply(429, { error: '按键过于频繁，请稍后重试', posted: false });
      rate.count++; rates.set(owner, rate);
      let result, attempted = false;
      try {
        const state = JSON.parse(native.snapshot());
        if (!state.trusted) result = reply(403, { error: '请在 Mac 系统设置中开启辅助功能权限', posted: false });
        else if (state.target?.id !== lease.target.id) result = reply(409, { error: '前台应用已变化，请刷新目标后重试', posted: false });
        else {
          const flags = shortcut.modifiers.reduce((flags, modifier) => flags | MODIFIER_FLAGS[modifier], 0);
          const remainingMs = lease.expires - now();
          if (remainingMs <= 0) throw Object.assign(new Error('按键请求已过期，请主动重试'), { code: 'STALE' });
          attempted = true;
          const sent = JSON.parse(native.press(lease.target.id, textInput ? shortcut.text : KEY_CODES[shortcut.key], flags, remainingMs));
          if (sent.posted !== true || sent.target?.id !== lease.target.id) throw new Error('invalid native reply');
          onPosted({ owner, key: textInput ? null : shortcut.key, modifiers: shortcut.modifiers, target: sent.target, uncertain: Boolean(sent.targetChangedDuringPost) });
          result = reply(200, { operationId: body.operationId, ...sent, confirmed: false,
            message: sent.targetChangedDuringPost ? '投递期间前台应用变化，结果未确认，请勿自动重发' : textInput ? '文字已投递，请在 Mac 确认内容；未自动提交' : '按键已投递，应用执行结果未确认' });
        }
      } catch (error) {
        if (attempted) onPosted({ owner, key: textInput ? null : shortcut.key, modifiers: shortcut.modifiers, target: lease.target, uncertain: true });
        const status = { PERMISSION: 403, TARGET_CHANGED: 409, STALE: 409, INVALID: 400 }[error.code];
        result = reply(status || 500, { error: status ? error.message : '按键结果未确认，请勿自动重发', posted: status ? false : null });
      }
      outcomes.set(id, { fingerprint, result, expires: time + 30000 });
      return result;
    },
  };
}
