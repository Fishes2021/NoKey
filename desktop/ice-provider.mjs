import { persistentRelayIdentity, relayDeviceUrl } from '../bridge/lib/remote-relay.mjs';
import { validateIceConfig } from '../mobile/lib/ice-config.mjs';

export function createIceProvider({ relayOrigin, stateDir, fetchImpl = fetch, now = Date.now }) {
  let cached = null, pending = null;
  return async () => {
    if (!relayOrigin) return { iceServers: [], expiresAt: null };
    if (cached?.expiresAt > now() + 5 * 60000) return cached;
    if (pending) return pending;
    pending = (async () => {
      const identity = await persistentRelayIdentity(stateDir);
      const response = await fetchImpl(`${relayDeviceUrl(relayOrigin, identity.deviceId)}/ice`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000),
        headers: { 'X-Microdex-Device-Secret': identity.deviceSecret, Accept: 'application/json' },
      });
      if (!response.ok) throw Object.assign(new Error(`国内媒体中继凭据获取失败 (${response.status})`), { statusCode: 503 });
      const reader = response.body.getReader();
      let data = '', bytes = 0;
      const decoder = new TextDecoder();
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          bytes += part.value.byteLength;
          if (bytes > 16384) throw new Error('媒体中继配置过大');
          data += decoder.decode(part.value, { stream: true });
        }
        data += decoder.decode();
      } finally { await reader.cancel(); }
      const config = validateIceConfig(JSON.parse(data), now());
      if (!config.iceServers.some(server => server.urls.some(url => /^turns?:/.test(url))))
        throw new Error('国内媒体中继未提供 TURN 连接地址');
      cached = config;
      return cached;
    })();
    try { return await pending; }
    finally { pending = null; }
  };
}
