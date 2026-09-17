export type ShortcutModifier = 'command' | 'control' | 'option' | 'shift' | 'fn';
export type KeyboardShortcut = { key: string; modifiers: ShortcutModifier[] };
export const KEY_CODES: Readonly<Record<string, number>>;
export const MODIFIER_FLAGS: Readonly<Record<ShortcutModifier, number>>;
export function normalizeShortcut(value: unknown): KeyboardShortcut;
