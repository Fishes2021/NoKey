// SPDX-License-Identifier: GPL-3.0-only
import { normalizeShortcut } from '../mobile/lib/keyboard-shortcuts.mjs';
export const DEFAULT_DICTATION = Object.freeze({ key: 'RightOption', modifiers: [], sendDelayMs: 350 });
export function normalizeDictation(value) {
  const shortcut = normalizeShortcut(value);
  if (!Number.isInteger(value.sendDelayMs) || value.sendDelayMs < 0 || value.sendDelayMs > 3000)
    throw new Error('结束后发送延迟须为 0–3000 毫秒');
  if (shortcut.modifiers.includes('fn')) throw new Error('语音快捷键暂不支持 Fn／地球键');
  return { ...shortcut, sendDelayMs: value.sendDelayMs };
}
