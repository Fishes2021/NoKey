// SPDX-License-Identifier: GPL-3.0-only
import { normalizeShortcut } from '../mobile/lib/keyboard-shortcuts.mjs';
const codes = { MetaLeft: 'LeftCommand', MetaRight: 'RightCommand', AltLeft: 'LeftOption', AltRight: 'RightOption',
  ControlLeft: 'LeftControl', ControlRight: 'RightControl', ShiftLeft: 'LeftShift', ShiftRight: 'RightShift',
  Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\',
  Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/' };
const flags = { command: 'metaKey', control: 'ctrlKey', option: 'altKey', shift: 'shiftKey' };
export function recordedShortcut(event, heldCodes = []) {
  if (event.isComposing || event.getModifierState?.('Fn')) throw new Error('暂不支持输入法组合输入或 Fn／地球键');
  const key = codes[event.code] || event.code.replace(/^Key(?=[A-Z]$)|^Digit(?=[0-9]$)/, '');
  const own = /^(?:Left|Right)(Command|Control|Option|Shift)$/.exec(key)?.[1].toLowerCase();
  const modifiers = Object.keys(flags).filter(name => name !== own && event[flags[name]]).map(name => {
    const held = [...heldCodes].map(code => codes[code]).filter(Boolean).find(key => key.replace(/^(Left|Right)/, '').toLowerCase() === name);
    if (!held) throw new Error('请先松开所有按键，再重新录入，以识别左右按键');
    return held;
  });
  return normalizeShortcut({ key, modifiers });
}
