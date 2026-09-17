// Validate the operator-owned media configuration before passing it to WebRTC.
export function validateIceConfig(value, now = Date.now()) {
  if (!value || !Array.isArray(value.iceServers) || value.iceServers.length > 8)
    throw new Error('媒体中继配置无效');
  if (value.iceServers.length && (!Number.isFinite(value.expiresAt) ||
      value.expiresAt < now + 60000 || value.expiresAt > now + 2 * 60 * 60 * 1000))
    throw new Error('媒体中继凭据已过期或有效期无效');
  const iceServers = value.iceServers.map(server => {
    const urls = typeof server?.urls === 'string' ? [server.urls] : server?.urls;
    if (!Array.isArray(urls) || urls.length < 1 || urls.length > 8 || urls.some(url =>
      typeof url !== 'string' || url.length > 512 ||
      !/^(stun|turn|turns):(?:[a-zA-Z0-9.-]+|\[[a-fA-F0-9:]+\])(?::\d{1,5})?(?:\?transport=(udp|tcp))?$/.test(url)))
      throw new Error('媒体中继地址无效');
    const turn = urls.some(url => /^turns?:/.test(url));
    if (turn && (typeof server.username !== 'string' || server.username.length < 1 || server.username.length > 256 ||
        typeof server.credential !== 'string' || server.credential.length < 1 || server.credential.length > 256))
      throw new Error('媒体中继凭据缺失');
    return { urls: [...urls], ...(turn ? { username: server.username, credential: server.credential } : {}) };
  });
  return { iceServers, expiresAt: iceServers.length ? value.expiresAt : null };
}
