// SPDX-License-Identifier: GPL-3.0-only
import { readFile, writeFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
export const PHONE_MIC_UID = 'VoiceDeckMicrophone_UID';

// One system input device belongs to one active voice session. Keep the recovery
// record on disk before changing it, including when the process crashes mid-call.
export async function createMicrophoneSelection(native, stateDir) {
  const file = path.join(stateDir, 'microphone-recovery.json');
  let recovery = null, message = '', queue = Promise.resolve();
  try {
    const saved = JSON.parse(await readFile(file, 'utf8'));
    if (typeof saved?.uid !== 'string' || !saved.uid || saved.uid === PHONE_MIC_UID ||
        typeof saved.name !== 'string') throw new Error('麦克风恢复记录无效');
    recovery = { uid: saved.uid, name: saved.name };
    message = '上次麦克风恢复未完成，请点击恢复原麦克风';
  } catch (error) { if (error.code !== 'ENOENT') message = `恢复记录读取失败：${error.message}`; }
  const serial = action => {
    const result = queue.then(action);
    queue = result.catch(error => { message = error.message; });
    return result;
  };
  const save = async value => {
    if (value) {
      await writeFile(`${file}.tmp`, JSON.stringify(value) + '\n', { mode: 0o600 });
      await rename(`${file}.tmp`, file);
    } else await rm(file, { force: true });
    recovery = value;
  };
  const select = async uid => {
    const status = native.selectInput(uid);
    if (status) throw new Error(`麦克风切换失败 (${status})`);
    for (let attempt = 0; attempt < 20; attempt++) {
      if (native.inputDevices().find(device => device.selected)?.uid === uid) return;
      await delay(50);
    }
    throw new Error('系统未确认麦克风切换，请检查当前设备');
  };
  const restore = () => serial(async () => {
    const devices = native.inputDevices();
    const current = devices.find(device => device.selected);
    if (!recovery) {
      if (current?.uid === PHONE_MIC_UID) throw new Error('没有原麦克风记录，请选择要恢复的设备');
      return { restored: false };
    }
    if (current?.uid !== PHONE_MIC_UID) {
      await save(null); message = '保留当前麦克风选择'; return { restored: false };
    }
    if (!devices.some(device => device.uid === recovery.uid)) throw new Error(`原麦克风“${recovery.name}”不可用，请选择其他设备`);
    await select(recovery.uid);
    const name = recovery.name;
    await save(null); message = `已恢复：${name}`;
    return { restored: true };
  });
  return {
    snapshot() {
      try { return { devices: native.inputDevices(), recovery, message }; }
      catch (error) { return { devices: [], recovery, message: error.message }; }
    },
    acquire: () => serial(async () => {
      const devices = native.inputDevices();
      const current = devices.find(device => device.selected);
      if (!devices.some(device => device.uid === PHONE_MIC_UID)) throw new Error('手机虚拟麦克风不可用');
      if (current?.uid === PHONE_MIC_UID) {
        if (!recovery) throw new Error('请先在桌面端选择原麦克风，再开始讲话');
        return { selected: true };
      }
      if (!current) throw new Error('没有可记录的系统麦克风，请先选择设备');
      await save({ uid: current.uid, name: current.name });
      await select(PHONE_MIC_UID); message = '正在使用手机麦克风';
      return { selected: true };
    }),
    restore,
    chooseRecovery: uid => serial(async () => {
      const device = native.inputDevices().find(device => device.uid === uid && uid !== PHONE_MIC_UID);
      if (!device) throw new Error('请选择可用的实体麦克风');
      await select(uid); await save(null); message = `已切换：${device.name}`;
      return { restored: true };
    }),
  };
}
