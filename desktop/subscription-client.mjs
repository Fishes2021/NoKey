import { createHash } from 'node:crypto';
import { normalizeRelayOrigin, persistentRelayIdentity, relayDeviceUrl } from '../bridge/lib/remote-relay.mjs';
export async function subscriptionRequest({ origin, stateDir, code, fetchImpl = fetch }) {
  origin = normalizeRelayOrigin(origin);
  const identity = await persistentRelayIdentity(stateDir);
  if (code !== undefined && (typeof code !== 'string' || !/^NK-[A-Za-z0-9_-]{32}$/.test(code))) throw new Error('激活码格式无效');
  const response = await fetchImpl(code ? `${origin}/v1/activate` : `${relayDeviceUrl(origin, identity.deviceId)}/subscription`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000),
    headers: code ? { 'Content-Type': 'application/json' } : { 'X-Microdex-Device-Secret': identity.deviceSecret },
    body: code ? JSON.stringify({ code, deviceId: identity.deviceId, secretHash: createHash('sha256').update(identity.deviceSecret).digest('hex') }) : undefined,
  });
  const reader = response.body.getReader(); let text = '', size = 0; const decoder = new TextDecoder();
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.length; if (size > 8192) throw new Error('授权响应过大');
      text += decoder.decode(part.value, { stream: true });
    }
    text += decoder.decode();
  } finally { await reader.cancel(); }
  const result = JSON.parse(text);
  if (!response.ok) throw new Error(typeof result.error === 'string' ? result.error.slice(0, 200) : '无法获取中继授权，请检查服务地址');
  if (!['active', 'expired', 'inactive', 'revoked'].includes(result.status) || (result.expiresAt !== null && !Number.isSafeInteger(result.expiresAt))) throw new Error('中继授权响应无效');
  return { status: result.status, expiresAt: result.expiresAt };
}
