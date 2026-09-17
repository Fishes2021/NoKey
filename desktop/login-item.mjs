// SPDX-License-Identifier: GPL-3.0-only
// Only register the installed Chinese-named app, never Electron or a build copy.
const installedExecutables = ['/Applications/NoKey.app/Contents/MacOS/语音快捷键盘', '/Applications/语音快捷键盘.app/Contents/MacOS/语音快捷键盘'];
export function readLoginItem(app) {
  const available = app.isPackaged && installedExecutables.includes(app.getPath('exe'));
  if (!available) return { available: false, status: 'unavailable' };
  try {
    const { status } = app.getLoginItemSettings({ type: 'mainAppService' });
    return { available: true, status };
  } catch {
    return { available: true, status: 'unknown' };
  }
}

export function setLoginItem(app, enabled) {
  if (typeof enabled !== 'boolean') throw new Error('登录启动设置无效');
  const current = readLoginItem(app);
  if (!current.available) throw new Error('请从应用程序目录中的 NoKey设置登录启动');
  if ((enabled ? ['enabled', 'requires-approval'] : ['not-registered', 'not-found']).includes(current.status)) return current;
  app.setLoginItemSettings({ type: 'mainAppService', openAtLogin: enabled });
  const state = readLoginItem(app);
  if (!(enabled ? ['enabled', 'requires-approval'] : ['not-registered', 'not-found']).includes(state.status)) {
    throw new Error('系统未确认登录启动设置，请在系统设置中检查后刷新');
  }
  return state;
}
