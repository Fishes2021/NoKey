// SPDX-License-Identifier: GPL-3.0-only
let host = null;

// Installed by the Electron main process. The CLI can still serve shortcuts
// without a media engine; voice endpoints then return a clear 503.
export function setVoiceHost(value) { host = value; }

export async function handleVoiceRequest(context, audioHost = host, startDictation = null) {
  const payload = context?.payload;
  if (typeof payload?.path !== 'string' || !payload.path.startsWith('/api/voice/')) return null;
  const response = (status, body) => ({ status, contentType: 'application/json; charset=utf-8', body: JSON.stringify(body) });
  // context is produced by E2EEClientRegistry.openSessionMessage, never by JSON
  // from a phone. The phone cannot select another device by putting owner in body.
  const owner = context.material?.keyId;
  if (!owner) return response(401, { error: '需要已配对的加密设备身份' });
  if (payload.method !== 'POST') return response(405, { error: '语音接口需要 POST' });
  const operation = payload.path.slice('/api/voice/'.length);
  if (!['config', 'restart', 'offer', 'status', 'gain', 'stop'].includes(operation)) return response(404, { error: '未知语音操作' });
  const body = payload.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return response(400, { error: '请求内容无效' });
  if (operation === 'offer' || operation === 'restart') {
    if (body.description?.type !== 'offer' || typeof body.description.sdp !== 'string' ||
        body.description.sdp.length > 24000) return response(400, { error: '音频 offer 无效' });
  }
  if (!['offer', 'config'].includes(operation)) {
    if (typeof body.sessionId !== 'string' || !/^[a-f0-9-]{36}$/.test(body.sessionId))
      return response(400, { error: '语音会话标识无效' });
    if (operation === 'gain' && (!Number.isFinite(body.gain) || body.gain < 0 || body.gain > 4))
      return response(400, { error: '音量范围为 0–4' });
  }
  if (operation === 'offer' && body.dictationLeaseId !== undefined &&
      (typeof body.dictationLeaseId !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(body.dictationLeaseId)))
    return response(400, { error: '听写目标标识无效' });
  if (!audioHost) return response(503, { error: '请启动语音快捷键盘 Mac 客户端' });
  try {
    const result = operation === 'config' ? await audioHost.config(owner) : operation === 'offer'
      ? await audioHost.offer(owner, { type: body.description.type, sdp: body.description.sdp }, body.dictationLeaseId && startDictation ? shortcut => startDictation(body.dictationLeaseId, shortcut) : null)
      : await audioHost.control(operation, owner, { sessionId: body.sessionId, gain: body.gain, ...(operation === 'restart' ? { description: { type: body.description.type, sdp: body.description.sdp } } : {}) });
    return response(200, result);
  } catch (error) {
    const status = [400, 401, 404, 409, 503, 504].includes(error.statusCode) ? error.statusCode : 500;
    return response(status, { error: status === 500 ? '语音服务发生错误' : error.message });
  }
}
