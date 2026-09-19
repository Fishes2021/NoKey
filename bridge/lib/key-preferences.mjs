// SPDX-License-Identifier: GPL-3.0-only
import { readFile, writeFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { normalizeShortcut } from '../../mobile/lib/keyboard-shortcuts.mjs';
import { persistentRelayIdentity } from './remote-relay.mjs';
const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
export function validateKeyPreferences(keys) {
  if (!Array.isArray(keys) || keys.length !== 10) throw fail('快捷键配置须包含10个位置');
  return keys.map(entry => {
    if (entry === null) return null;
    if (!entry || typeof entry !== 'object' || typeof entry.keycapId !== 'string' || !/^[A-Z0-9+_-]{1,24}$/.test(entry.keycapId) ||
        (entry.label !== undefined && (typeof entry.label !== 'string' || entry.label.length > 24 || /[\x00-\x1f\x7f]/.test(entry.label)))) throw fail('快捷键名称或图标无效');
    if (entry.action !== null && entry.action?.type !== 'shortcut') throw fail('仅支持系统快捷键');
    return { keycapId: entry.keycapId, ...(entry.label !== undefined ? {label: entry.label} : {}),
      action: entry.action === null ? null : { type: 'shortcut', ...normalizeShortcut(entry.action) } };
  });
}
export async function createKeyPreferences(stateDir) {
  const { deviceId: macId } = await persistentRelayIdentity(stateDir);
  const file = path.join(stateDir, 'keyboard-layout.json');
  let saved = { revision: 0, keys: null }, saving = false, damaged = false;
  try {
    const data = JSON.parse(await readFile(file, 'utf8'));
    if (!Number.isSafeInteger(data.revision) || data.revision < 1) throw Error('invalid revision');
    saved = { revision: data.revision, keys: validateKeyPreferences(data.keys) };
  } catch (error) { if (error.code !== 'ENOENT') damaged = true; }
  return {
    read() { if (damaged) throw fail('Mac 保存的快捷配置损坏，请恢复备份；不会覆盖原文件', 503); return { macId, ...saved }; },
    async save(body) {
      if (damaged) throw fail('Mac 快捷配置损坏，未覆盖原文件', 503);
      if (saving || body?.revision !== saved.revision) throw fail('快捷配置已变化，请重新打开设置后再保存', 409);
      const keys = validateKeyPreferences(body.keys);
      saving = true; const temporary = `${file}.tmp`;
      try {
        const next = { revision: saved.revision + 1, keys };
        await writeFile(temporary, JSON.stringify(next) + '\n', { mode: 0o600 });
        await rename(temporary, file); saved = next; return { macId, ...saved };
      } finally { saving = false; await rm(temporary, { force: true }); }
    },
  };
}
