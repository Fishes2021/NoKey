import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createMicrophoneSelection, PHONE_MIC_UID } from './microphone-selection.mjs';

test('microphone takeover preserves identity, manual changes, and crash recovery', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'voicedeck-mic-test-'));
  let selected = 'wireless', available = ['wireless', 'usb', PHONE_MIC_UID], fail = false;
  const native = {
    inputDevices: () => available.map(uid => ({ uid, name: uid, selected: selected === uid })),
    selectInput: uid => { if (fail) return -1; selected = uid; return 0; },
  };
  try {
    const mic = await createMicrophoneSelection(native, directory);
    assert.equal(selected, 'wireless', 'opening must not change system input');
    await mic.acquire(); await mic.acquire();
    assert.equal(mic.snapshot().recovery.uid, 'wireless');
    await mic.restore(); assert.equal(selected, 'wireless');
    selected = 'usb'; await mic.acquire();
    const recovered = await createMicrophoneSelection(native, directory);
    await recovered.restore(); assert.equal(selected, 'usb');
    await mic.acquire(); selected = 'wireless';
    await mic.restore(); assert.equal(selected, 'wireless', 'user choice must win');
    fail = true; await assert.rejects(mic.acquire(), /切换失败/);
    assert.equal(selected, 'wireless'); fail = false;
    await mic.acquire(); available = ['usb', PHONE_MIC_UID];
    await assert.rejects(mic.restore(), /不可用/);
    assert.equal(mic.snapshot().recovery.uid, 'wireless');
    await mic.chooseRecovery('usb'); assert.equal(selected, 'usb');
    await assert.rejects(mic.chooseRecovery(PHONE_MIC_UID));
    selected = PHONE_MIC_UID;
    await assert.rejects(mic.acquire(), /选择原麦克风/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
