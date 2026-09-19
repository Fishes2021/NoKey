// SPDX-License-Identifier: GPL-3.0-only
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, chmodSync } from 'node:fs';
import path from 'node:path';

const hash = value => createHash('sha256').update(value).digest('hex');
const idPattern = /^[A-Za-z0-9_-]{20,64}$/;
export function addMonths(timestamp, months) {
  const date = new Date(timestamp), day = date.getUTCDate();
  date.setUTCDate(1); date.setUTCMonth(date.getUTCMonth() + months);
  const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, last)); return date.getTime();
}
export function openSubscriptions(filename, now = Date.now) {
  if (!path.isAbsolute(filename)) throw new Error('授权数据库需要绝对路径');
  mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(filename);
  chmodSync(filename, 0o600);
  db.exec(`PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS devices(id TEXT PRIMARY KEY, secret_hash TEXT NOT NULL, expires_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS codes(digest TEXT PRIMARY KEY, months INTEGER NOT NULL, device_id TEXT, redeemed_at INTEGER);
  `);
  const device = id => db.prepare('SELECT * FROM devices WHERE id=?').get(id);
  const status = id => {
    const row = device(id);
    return { status: !row ? 'inactive' : row.revoked ? 'revoked' : row.expires_at <= now() ? 'expired' : 'active', expiresAt: row?.expires_at ?? null };
  };
  return {
    status, ids: () => db.prepare('SELECT id FROM devices').all().map(row => row.id),
    authenticate(id, secret) {
      const row = device(id);
      return Boolean(row && typeof secret === 'string' && secret.length >= 32 && secret.length <= 256 &&
        timingSafeEqual(Buffer.from(row.secret_hash, 'hex'), Buffer.from(hash(secret), 'hex')));
    },
    issue(months) {
      if (![1, 12].includes(months)) throw new Error('仅支持1个月或12个月');
      const code = 'NK-' + randomBytes(24).toString('base64url');
      db.prepare('INSERT INTO codes(digest,months) VALUES(?,?)').run(hash(code), months);
      return code; // Only returned once to the operator; never stored as plaintext.
    },
    redeem({ code, deviceId, secretHash }) {
      if (typeof code !== 'string' || !/^NK-[A-Za-z0-9_-]{32}$/.test(code) || !idPattern.test(deviceId || '') || !/^[a-f0-9]{64}$/.test(secretHash || ''))
        throw new Error('激活信息无效');
      db.exec('BEGIN IMMEDIATE');
      try {
        const grant = db.prepare('SELECT * FROM codes WHERE digest=?').get(hash(code));
        const row = device(deviceId);
        if (!grant || (grant.device_id && grant.device_id !== deviceId) || (row && row.secret_hash !== secretHash)) throw new Error('激活码无效或已绑定其他设备');
        if (row?.revoked) throw new Error('该设备授权已停用，请联系服务提供方');
        if (!grant.device_id) {
          const expiresAt = addMonths(Math.max(now(), row?.expires_at || 0), grant.months);
          db.prepare('INSERT INTO devices(id,secret_hash,expires_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET expires_at=excluded.expires_at').run(deviceId, secretHash, expiresAt);
          db.prepare('UPDATE codes SET device_id=?,redeemed_at=? WHERE digest=?').run(deviceId, now(), hash(code));
        }
        db.exec('COMMIT'); return status(deviceId);
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    revoke(id) {
      if (!idPattern.test(id || '')) throw new Error('设备ID无效');
      if (!db.prepare('UPDATE devices SET revoked=1 WHERE id=?').run(id).changes) throw new Error('设备不存在');
    },
    close: () => db.close(),
  };
}
