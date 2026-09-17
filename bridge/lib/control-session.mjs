// SPDX-License-Identifier: GPL-3.0-only
// One paired device controls this Mac. Audio keeps ownership even when iOS
// suspends foreground polling; pending commands must finish before handover.
export function createControlSession({ voiceOwner = () => null, now = () => performance.now() } = {}) {
  let active = null;
  function prune() {
    if (active && !active.pending && active.expires <= now() && voiceOwner() !== active.owner) active = null;
  }
  return {
    ticket(owner) {
      prune();
      return active?.owner === owner && !active.revoked ? active : null;
    },
    async run(owner, operation, { existing = false } = {}) {
      if (typeof owner !== 'string' || !owner) throw Object.assign(new Error('需要已配对身份'), { statusCode: 401 });
      prune();
      if (existing && (!active || active !== existing || active.owner !== owner || active.revoked)) {
        return { status: 409, contentType: 'application/json', body: JSON.stringify({
          code: 'CONTROL_EXPIRED', error: '原手机控制会话已结束，此消息未发送；请检查 Mac 后重新操作',
        }) };
      }
      const audio = voiceOwner();
      if ((active && (active.owner !== owner || active.revoked)) || (audio && audio !== owner)) {
        return { status: 409, contentType: 'application/json', body: JSON.stringify({
          code: 'CONTROL_BUSY', error: '这台 Mac 正由另一台手机控制，请在原手机停止讲话并将 App 切到后台，或在 Mac 撤销该手机配对',
        }) };
      }
      const reservation = active ||= { owner, pending: 0, expires: 0, revoked: false };
      reservation.pending++;
      try { return await operation(); }
      finally {
        reservation.pending--;
        reservation.expires = reservation.revoked ? 0 : now() + 10000;
        prune();
      }
    },
    revoke(owner) {
      if (active?.owner !== owner) return;
      active.revoked = true;
      active.expires = 0;
      prune();
    },
  };
}
