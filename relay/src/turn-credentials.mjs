// Server-only. Never ship the shared signing secret to either client.
// Protocol: https://github.com/coturn/coturn/blob/master/README.turnserver#turn-rest-api
import { createHmac } from 'node:crypto';
import { validateIceConfig } from '../../mobile/lib/ice-config.mjs';

export function issueTurnCredentials({ secret, urls, deviceId, ttlSeconds = 3600, now = Date.now() }) {
  if (typeof secret !== 'string' || Buffer.byteLength(secret) < 32 ||
      typeof deviceId !== 'string' || !/^[A-Za-z0-9_-]{20,64}$/.test(deviceId) ||
      !Number.isInteger(ttlSeconds) || ttlSeconds < 600 || ttlSeconds > 7200 || !Number.isFinite(now))
    throw new Error('TURN 签发配置无效');
  const expiry = Math.floor(now / 1000) + ttlSeconds;
  const username = `${expiry}:${deviceId}`;
  const credential = createHmac('sha1', secret).update(username).digest('base64');
  const config = validateIceConfig({ iceServers: [{ urls, username, credential }], expiresAt: expiry * 1000 }, now);
  if (!config.iceServers[0].urls.some(url => /^turns?:/.test(url))) throw new Error('必须配置 TURN 地址');
  return config;
}
