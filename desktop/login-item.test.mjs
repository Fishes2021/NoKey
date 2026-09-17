import assert from 'node:assert/strict';
import test from 'node:test';
import { readLoginItem, setLoginItem } from './login-item.mjs';

test('login registration is explicit, installed-app-only and reflects system approval', () => {
  let status = 'not-registered', writes = 0, needsApproval = false, ignore = false;
  const app = {
    isPackaged: true,
    getPath: () => '/Applications/语音快捷键盘.app/Contents/MacOS/语音快捷键盘',
    getLoginItemSettings(options) { assert.equal(options.type, 'mainAppService'); return { status }; },
    setLoginItemSettings(options) {
      assert.equal(options.type, 'mainAppService'); writes++;
      if (!ignore) status = options.openAtLogin ? needsApproval ? 'requires-approval' : 'enabled' : 'not-registered';
    },
  };
  assert.equal(readLoginItem(app).status, 'not-registered'); assert.equal(writes, 0);
  assert.equal(setLoginItem(app, true).status, 'enabled'); assert.equal(writes, 1);
  setLoginItem(app, true); assert.equal(writes, 1);
  assert.equal(setLoginItem(app, false).status, 'not-registered');
  needsApproval = true;
  assert.equal(setLoginItem(app, true).status, 'requires-approval');
  setLoginItem(app, false);
  ignore = true;
  assert.throws(() => setLoginItem(app, true), /未确认/);
  assert.throws(() => setLoginItem(app, 'true'), /无效/);
  const before = writes;
  app.getPath = () => '/tmp/build/语音快捷键盘.app/Contents/MacOS/语音快捷键盘';
  assert.equal(readLoginItem(app).available, false);
  assert.throws(() => setLoginItem(app, true), /应用程序目录/);
  assert.equal(writes, before);
  app.getPath = () => '/Applications/语音快捷键盘.app/Contents/MacOS/语音快捷键盘';
  app.getLoginItemSettings = () => { throw new Error('system unavailable'); };
  assert.equal(readLoginItem(app).status, 'unknown');
});


test('NoKey installed path keeps login registration available', () => {
  const app = { isPackaged: true, getPath: () => '/Applications/NoKey.app/Contents/MacOS/语音快捷键盘',
    getLoginItemSettings: () => ({ status: 'not-registered' }) };
  assert.deepEqual(readLoginItem(app), { available: true, status: 'not-registered' });
});
