// SPDX-License-Identifier: GPL-3.0-only
// macOS virtual key positions; no text, scripts or app activation commands.
export const KEY_CODES = Object.freeze({
  A: 0, S: 1, D: 2, F: 3, H: 4, G: 5, Z: 6, X: 7, C: 8, V: 9, B: 11,
  Q: 12, W: 13, E: 14, R: 15, Y: 16, T: 17, '1': 18, '2': 19, '3': 20, '4': 21,
  '6': 22, '5': 23, '=': 24, '9': 25, '7': 26, '-': 27, '8': 28, '0': 29,
  ']': 30, O: 31, U: 32, '[': 33, I: 34, P: 35, Enter: 36, L: 37, J: 38,
  "'": 39, K: 40, ';': 41, '\\': 42, ',': 43, '/': 44, N: 45, M: 46, '.': 47,
  Tab: 48, Space: 49, '`': 50, Backspace: 51, Escape: 53, RightOption: 61, LeftOption: 58, LeftControl: 59, RightControl: 62, LeftShift: 56, RightShift: 60, LeftCommand: 55, RightCommand: 54,
  F1: 122, F2: 120, F3: 99, F4: 118, F5: 96, F6: 97, F7: 98, F8: 100,
  F9: 101, F10: 109, F11: 103, F12: 111, F13: 105, F14: 107, F15: 113,
  F16: 106, F17: 64, F18: 79, F19: 80, F20: 90,
  Home: 115, PageUp: 116, Delete: 117, End: 119, PageDown: 121,
  ArrowLeft: 123, ArrowRight: 124, ArrowDown: 125, ArrowUp: 126,
});
export const MODIFIER_FLAGS = Object.freeze({ command: 1 << 20, control: 1 << 18, option: 1 << 19, shift: 1 << 17, fn: 1 << 23 });
export function normalizeShortcut(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      typeof value.key !== 'string' || !Object.hasOwn(KEY_CODES, value.key) ||
      !Array.isArray(value.modifiers) || value.modifiers.length > 5 ||
      (/^(Left|Right)(Option|Control|Shift|Command)$/.test(value.key) && value.modifiers.length !== 0) ||
      value.modifiers.some(modifier => typeof modifier !== 'string' || !Object.hasOwn(MODIFIER_FLAGS, modifier)) ||
      new Set(value.modifiers).size !== value.modifiers.length) throw new Error('请选择有效的按键和修饰键');
  return { key: value.key, modifiers: Object.keys(MODIFIER_FLAGS).filter(modifier => value.modifiers.includes(modifier)) };
}

const KEY_LABELS = { ArrowUp: '上方向键', ArrowRight: '右方向键', ArrowDown: '下方向键', ArrowLeft: '左方向键',
  Enter: '回车', Backspace: '退格', Delete: '向后删除', Space: '空格', Escape: '退出 Esc', Tab: '制表 Tab',
  Home: '文档开头', End: '文档结尾', PageUp: '上一页', PageDown: '下一页',
  LeftOption: '左 Option', RightOption: '右 Option', LeftControl: '左 Control', RightControl: '右 Control',
  LeftShift: '左 Shift', RightShift: '右 Shift', LeftCommand: '左 Command', RightCommand: '右 Command',
  command: 'Command ⌘', control: 'Control ⌃', option: 'Option ⌥', shift: 'Shift ⇧', fn: 'Fn 功能键' };
export function keyboardKeyLabel(key) { return KEY_LABELS[key] || key; }
