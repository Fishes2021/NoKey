// SPDX-License-Identifier: GPL-3.0-only
import { app, dialog } from 'electron';
import path from 'node:path';
import { startDesktop } from './main.mjs';
app.setName('NoKey');
app.setPath('userData', path.resolve(app.commandLine.getSwitchValue('user-data-dir') || path.join(app.getPath('appData'), 'VoiceDeck')));
if (!app.requestSingleInstanceLock()) app.quit();
else {
  let client, quitting = false;
  app.on('second-instance', () => { client?.window.show(); client?.window.focus(); });
  app.on('before-quit', event => {
    if (quitting) return;
    event.preventDefault(); quitting = true;
    Promise.resolve(client?.close()).finally(() => app.quit());
  });
  app.on('window-all-closed', () => app.quit());
  app.on('activate', () => { client?.window.show(); client?.window.focus(); });
  // Electron waits for the ESM entry to finish before emitting ready.
  // Awaiting whenReady at top level deadlocks a packaged app's startup.
  app.whenReady().then(async () => {
    try { app.dock?.hide(); client = await startDesktop({ host: process.env.MICRODEX_HOST || '0.0.0.0', port: Number(process.env.MICRODEX_PORT || 3210) }); }
    catch (error) { console.error(error.message); dialog.showErrorBox('客户端无法启动', error.message); app.quit(); }
  });
}
