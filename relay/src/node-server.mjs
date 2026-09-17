// Domestic/self-hosted runtime for the existing encrypted Microdex relay protocol.
import http from 'node:http';
import { createHash, randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { parseDeviceRoute, pairingPage, responseTimeout } from './index.js';
import { normalizeRelayOrigin } from '../../bridge/lib/remote-relay.mjs';
import { issueTurnCredentials } from './turn-credentials.mjs';

export async function startRelay({ publicOrigin, devices, turn, host = '127.0.0.1', port = 8787 }) {
  publicOrigin = normalizeRelayOrigin(publicOrigin);
  // Small private pilot: operator provisions device hashes; public enrolment is a separate release requirement.
  if (!devices || Object.keys(devices).length > 100 || Object.entries(devices).some(([id, digest]) =>
    !/^[A-Za-z0-9_-]{20,64}$/.test(id) || typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)))
    throw new Error('设备登记配置无效');
  if (turn) issueTurnCredentials({ ...turn, deviceId: 'configuration_validation' });
  const rooms = new Map(Object.keys(devices).map(id => [id, { mac: null, phones: new Map(), pending: new Map(), requests: 0 }]));
  const metrics = { requests: 0, forwardedBytes: 0, rejected: 0, iceIssued: 0 };
  const actors = new Map();
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 400000, perMessageDeflate: false });
  let globalPending = 0, stopping;
  const limited = (request, room) => {
    const ip = request.socket.remoteAddress;
    if (!actors.has(ip) && actors.size >= 1024) return true;
    const count = (actors.get(ip) || 0) + 1; actors.set(ip, count);
    if (room) room.requests++;
    return count > 6000 || (room?.requests || 0) > 1800;
  };
  const authenticateMac = (request, id) => {
    const secret = request.headers['x-microdex-device-secret'];
    if (!devices[id] || typeof secret !== 'string' || secret.length < 32 || secret.length > 256) return false;
    const digest = createHash('sha256').update(secret).digest();
    return timingSafeEqual(digest, Buffer.from(devices[id], 'hex'));
  };
  const reply = (response, status, payload) => {
    if (response.destroyed || response.writableEnded) return;
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff', 'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
    response.end(status === 204 ? '' : JSON.stringify(payload));
  };
  const send = (socket, message) => {
    if (socket?.readyState !== WebSocket.OPEN) return false;
    if (socket.bufferedAmount > 1000000) { socket.terminate(); return false; }
    const data = JSON.stringify(message);
    metrics.forwardedBytes += Buffer.byteLength(data);
    socket.send(data); return true;
  };
  const endPending = (room, id, status, body) => {
    const pending = room.pending.get(id);
    if (!pending) return;
    room.pending.delete(id); globalPending--; clearTimeout(pending.timer);
    if (pending.response.destroyed || pending.response.writableEnded) return;
    pending.response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*', 'X-Content-Type-Options': 'nosniff' });
    pending.response.end(body);
  };
  const disconnectMac = (room, socket) => {
    if (room.mac !== socket) return;
    room.mac = null;
    for (const id of room.pending.keys()) endPending(room, id, 503, JSON.stringify({ error: 'Mac 已断开', code: 'MAC_OFFLINE' }));
    for (const phone of room.phones.values()) phone.terminate();
  };
  const server = http.createServer(async (request, response) => {
    metrics.requests++;
    try {
      const url = new URL(request.url, publicOrigin);
      const route = parseDeviceRoute(url);
      const room = route && rooms.get(route.deviceId);
      if (limited(request, room)) { metrics.rejected++; return reply(response, 429, { error: '请求过于频繁' }); }
      if (url.pathname === '/health') return reply(response, 200, { ok: true, protocolVersion: 2, endToEndEncryption: true });
      if (request.method === 'OPTIONS') return reply(response, 204, {});
      if (!room) return reply(response, 404, { error: '设备未登记' });
      if (route.roomPath === '/ice' && request.method === 'POST') {
        if (!authenticateMac(request, route.deviceId)) return reply(response, 401, { error: '设备认证失败' });
        if (!turn) return reply(response, 503, { error: '媒体中继尚未配置' });
        metrics.iceIssued++;
        return reply(response, 200, issueTurnCredentials({ ...turn, deviceId: route.deviceId }));
      }
      if (route.roomPath === '/pair' && request.method === 'GET') {
        const code = url.searchParams.get('code') || '';
        if (!/^[A-Za-z0-9_-]{20,64}$/.test(code)) return reply(response, 400, { error: '配对链接无效' });
        const nonce = randomBytes(18).toString('base64');
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
          'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'` });
        return response.end(pairingPage(`${publicOrigin}${route.basePath}`, code, nonce).replaceAll('microdex:///', 'voicedeck:///'));
      }
      if (request.method !== 'POST' || !['/api/e2ee/pair', '/api/e2ee/session', '/api/e2ee'].includes(route.roomPath) || url.search)
        return reply(response, 404, { error: '仅支持加密客户端接口' });
      if (room.mac?.readyState !== WebSocket.OPEN) return reply(response, 503, { error: 'Mac 未在线', code: 'MAC_OFFLINE' });
      if (room.pending.size >= 32 || globalPending >= 128) return reply(response, 429, { error: '请求队列已满' });
      const id = randomUUID();
      // Reserve before reading the body, so slow senders cannot bypass the queue limit.
      globalPending++;
      const pending = { response, timer: setTimeout(() => endPending(room, id, 504, JSON.stringify({ error: 'Mac 响应超时' })), responseTimeout(route.roomPath)) };
      room.pending.set(id, pending);
      response.once('close', () => endPending(room, id, 499, ''));
      const chunks = []; let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 65536) { endPending(room, id, 413, JSON.stringify({ error: '请求过大' })); return; }
        chunks.push(chunk);
      }
      if (!room.pending.has(id)) return;
      const body = Buffer.concat(chunks).toString('utf8');
      if (!send(room.mac, { type: 'request', requestId: id, method: 'POST', path: route.roomPath, headers: {}, body }))
        endPending(room, id, 503, JSON.stringify({ error: 'Mac 未在线', code: 'MAC_OFFLINE' }));
    } catch { reply(response, 400, { error: '请求无效' }); }
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000;
  server.on('upgrade', (request, socket, head) => {
    let route;
    try { route = parseDeviceRoute(new URL(request.url, publicOrigin)); }
    catch { socket.destroy(); return; }
    const room = route && rooms.get(route.deviceId);
    const reject = status => { metrics.rejected++; socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); };
    if (limited(request, room)) return reject('429 Too Many Requests');
    if (!room) return reject('404 Not Found');
    const mac = route.roomPath === '/connect';
    if (!mac && !['/events', '/api/remote/events'].includes(route.roomPath)) return reject('404 Not Found');
    if (mac && !authenticateMac(request, route.deviceId)) return reject('401 Unauthorized');
    if (!mac && (!room.mac || room.phones.size >= 16)) return reject('503 Service Unavailable');
    sockets.handleUpgrade(request, socket, head, ws => {
      ws.on('error', () => ws.terminate());
      ws.alive = true; ws.on('pong', () => { ws.alive = true; });
      let messages = 0;
      const rate = setInterval(() => { messages = 0; }, 60000);
      const phoneId = mac ? null : randomUUID();
      if (mac) {
        const old = room.mac;
        if (old) { disconnectMac(room, old); old.terminate(); }
        room.mac = ws; send(ws, { type: 'connected' });
      } else room.phones.set(phoneId, ws);
      let authTimer = mac ? null : setTimeout(() => ws.terminate(), 10000);
      ws.on('close', () => {
        clearInterval(rate); clearTimeout(authTimer);
        if (mac) disconnectMac(room, ws);
        else { room.phones.delete(phoneId); send(room.mac, { type: 'phone-disconnected', phoneId }); }
      });
      ws.on('message', (raw, binary) => {
        if (++messages > (mac ? 3600 : 60) || binary) { ws.terminate(); return; }
        let message;
        try { message = JSON.parse(raw.toString()); if (!message || typeof message !== 'object') throw new Error(); }
        catch { ws.close(1008, 'Invalid message'); return; }
        if (!mac) {
          if (ws.authenticating || ws.authenticated) return;
          if (message.type !== 'e2ee-auth' || !message.envelope) { ws.close(1008, 'E2EE required'); return; }
          ws.authenticating = true;
          send(room.mac, { type: 'phone-auth', phoneId, envelope: message.envelope });
          return;
        }
        if (room.mac !== ws) return;
        if (message.type === 'response' && Number.isInteger(message.status) && message.status >= 200 && message.status <= 599 &&
            typeof message.body === 'string' && Buffer.byteLength(message.body) <= 400000)
          endPending(room, message.requestId, message.status, message.body);
        if (message.type === 'phone-auth-result') {
          const phone = room.phones.get(message.phoneId);
          if (!phone || !phone.authenticating || phone.authenticated) return;
          if (!message.ok || !message.e2ee) { phone.close(1008, 'Authentication failed'); return; }
          phone.authenticated = true; phone.clearAuthTimeout();
          send(phone, { type: 'ready', e2ee: true });
          if (message.stateEnvelope) send(phone, { type: 'e2ee', envelope: message.stateEnvelope });
        }
        if (message.type === 'phone-event') {
          const phone = room.phones.get(message.phoneId);
          if (phone?.authenticated && message.payload?.type === 'e2ee') send(phone, message.payload);
        }
      });
      // This timer belongs to this phone; a Mac auth result must clear it via the phone object.
      ws.clearAuthTimeout = () => { clearTimeout(authTimer); authTimer = null; };
    });
  });
  const heartbeat = setInterval(() => {
    for (const ws of sockets.clients) { if (!ws.alive) ws.terminate(); else { ws.alive = false; ws.ping(); } }
  }, 20000);
  const resetRates = setInterval(() => { actors.clear(); for (const room of rooms.values()) room.requests = 0; }, 60000);
  const close = () => stopping ??= Promise.resolve().then(async () => {
    clearInterval(heartbeat); clearInterval(resetRates);
    for (const ws of sockets.clients) ws.terminate();
    sockets.close();
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  });
  try { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); }); }
  catch (error) { await close(); throw error; }
  return { port: server.address().port, close, stats: () => ({ ...metrics, pending: globalPending,
    connectedMacs: [...rooms.values()].filter(room => room.mac?.readyState === WebSocket.OPEN).length }) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.env.VOICEDECK_RELAY_CONFIG) throw new Error('请指定 VOICEDECK_RELAY_CONFIG 配置文件');
  const config = JSON.parse(await readFile(process.env.VOICEDECK_RELAY_CONFIG, 'utf8'));
  const relay = await startRelay(config);
  console.log(`NoKey 中继已启动，监听端口 ${relay.port}`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => void relay.close());
}
