export type ShortcutModifier = 'command' | 'control' | 'option' | 'shift' | 'fn' | 'LeftCommand' | 'RightCommand' | 'LeftControl' | 'RightControl' | 'LeftOption' | 'RightOption' | 'LeftShift' | 'RightShift';
export type KeyboardShortcut = { key: string; modifiers: ShortcutModifier[] };
export const KEY_CODES: Readonly<Record<string, number>>;
export const MODIFIER_FLAGS: Readonly<Record<ShortcutModifier, number>>;
export function normalizeShortcut(value: unknown): KeyboardShortcut;

export function keyboardKeyLabel(key: string): string;
