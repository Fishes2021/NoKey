// Use coturn's existing loopback-only management interface to close expired allocations.
import net from 'node:net';
export function turnCommand({ port = 5766, password }, command) {
  if (!Number.isInteger(port) || port < 1 || port > 65535 || typeof password !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(password) || !/^(ps|cs [0-9]{1,20})$/.test(command))
    throw new Error('TURN本机管理配置或命令无效');
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    let buffer = '', stage = 0;
    const end = error => { socket.destroy(); if (error) reject(error); else resolve(buffer); };
    socket.setTimeout(3000, () => end(new Error('TURN管理接口超时')));
    socket.on('error', end);
    socket.on('end', () => { if (stage !== 3) end(new Error('TURN管理连接提前关闭')); });
    socket.on('data', data => {
      buffer += data.toString();
      if (buffer.length > 1024 * 1024) return end(new Error('TURN管理输出过大'));
      if (stage === 0 && /Enter password:/i.test(buffer)) { stage = 1; buffer = ''; socket.write(password + '\n'); }
      if (stage === 1 && />\s*$/.test(buffer)) { stage = 2; buffer = ''; socket.write(command + '\n'); }
      else if (stage === 2 && />\s*$/.test(buffer)) { stage = 3; end(); }
    });
  });
}
export async function closeExpiredTurnSessions(config, allowed) {
  const output = await turnCommand(config, 'ps');
  if (!/Total sessions:/i.test(output)) throw new Error('无法确认TURN会话清单');
  for (const match of output.matchAll(/id=(\d+), user <(\d+):([A-Za-z0-9_-]{20,64})>:/g)) {
    if (!allowed(match[3]) || Number(match[2]) * 1000 <= Date.now()) await turnCommand(config, `cs ${match[1]}`);
  }
}
