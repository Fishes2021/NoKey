import { VoiceReceiver } from './receiver.js';
const receiver = new VoiceReceiver({ onPCM: window.voiceEngine.pcm,
  onClear: window.voiceEngine.clear, onClosed: window.voiceEngine.closed });
window.voiceEngine.onRequest(async ({ id, operation, owner, body }) => {
  try {
    let result;
    if (operation === 'offer') {
      receiver.iceServers = body.iceServers;
      result = await receiver.offer(owner, body.description);
    } else if (operation === 'restart') {
      result = await receiver.restart(owner, body.sessionId, body.description, body.iceServers);
    } else if (operation === 'revoke') {
      if (receiver.active?.owner === owner) await receiver.close();
      result = { stopped: true };
    } else if (operation === 'stop') result = await receiver.stop(owner, body.sessionId);
    else if (operation === 'status') result = receiver.status(owner, body.sessionId);
    else if (operation === 'gain') result = receiver.gain(owner, body.sessionId, body.gain);
    else throw new Error('不支持的音频操作');
    document.getElementById('audio-error').textContent = '';
    renderAudio();
    window.voiceEngine.reply({ id, result });
  } catch (error) {
    document.getElementById('audio-error').textContent = error.message;
    renderAudio();
    window.voiceEngine.reply({ id, error: error.message, statusCode: error.statusCode || 500 });
  }
});

const renderAudio = () => {
  const status = receiver.receptionStatus();
  document.getElementById('state').textContent = {
    idle: '等待手机开始讲话', connecting: '正在建立音频连接…',
    interrupted: '音频连接中断，等待恢复', waiting: '音频通道已连接，暂未收到新的音频',
    receiving: 'Mac 已收到手机音频',
  }[status.state];
  document.getElementById('summary-audio').textContent = status.state === 'idle' ? '麦克风待机' : document.getElementById('state').textContent;
  if (receiver.lastError) document.getElementById('audio-error').textContent = receiver.lastError;
};
let desktopState, connectionDirty = false;
const renderExpiry = () => {
  if (!desktopState) return;
  const remaining = Math.max(0, Math.ceil((desktopState.expiresAt - Date.now()) / 1000));
  document.getElementById('expiry').textContent = remaining
    ? `配对二维码剩余 ${Math.ceil(remaining / 60)} 分钟有效；扫码后请在 Mac 确认。`
    : '二维码已过期，请刷新。';
  document.getElementById('qr').hidden = remaining === 0;
  document.getElementById('pairing-copy').disabled = remaining === 0;
  document.getElementById('pairing-text').value = remaining ? desktopState.pairingText || '' : '';
};
const renderNetwork = () => {
  if (!desktopState) return;
  const state = desktopState;
  const seconds = Math.max(0, Math.ceil(((state.remoteRetryAt || 0) - Date.now()) / 1000));
  document.getElementById('network').textContent = state.remoteReady ? '异网连接服务已连接'
    : !state.relayConfigured ? '当前为局域网连接；国内异网服务尚未配置。'
    : seconds ? `中继连接失败，${seconds} 秒后自动重试；请检查网络或服务设置。`
    : state.remoteStatus === 'connecting' ? '正在连接中继服务…'
    : '中继尚未连接，正在恢复；请检查网络或服务设置。';
  document.getElementById('network-diagnostics').hidden = !state.remoteError;
  document.getElementById('network-error').textContent = state.remoteError ? `最近一次连接错误：${String(state.remoteError).slice(0, 512)}` : '';
};
const renderDesktop = state => {
  if (!state) return;
  desktopState = state;
  document.getElementById('summary-phone').textContent = state.devices?.length ? `● 已配对 ${state.devices.length} 台手机` : '○ 尚未配对手机';
  document.getElementById('summary-network').textContent = state.remoteReady ? '异网服务已连接' : state.relayConfigured ? '异网服务连接中' : '局域网 · 等待手机使用';
  document.getElementById('summary-input').textContent = `当前输入 ${state.microphone?.devices?.find(device => device.selected)?.name || '未知'}`;
  document.getElementById('summary-keyboard').textContent = !state.keyboardEnabled ? '未启用' : state.keyboardTrusted ? '已启用' : '需要授权';
  const login = state.loginItem;
  document.getElementById('login-enable').disabled = !login?.available || ['enabled', 'requires-approval'].includes(login.status);
  document.getElementById('login-disable').disabled = !login?.available || ['not-registered', 'not-found'].includes(login.status);
  document.getElementById('login-status').textContent = ({
    unavailable: '请安装并从应用程序目录打开客户端后设置；开发副本不会注册登录项。',
    enabled: '登录启动已开启', 'not-registered': '登录启动已关闭', 'not-found': '登录启动未注册',
    'requires-approval': '等待系统允许：请在系统设置的登录项中允许 NoKey，然后刷新状态。',
    unknown: '无法读取登录启动状态，请在系统设置中检查。',
  })[login?.status] || '启动状态未知';
  document.getElementById('device-name').textContent = `本机名称：${state.deviceName || '未知'}`;
  document.getElementById('connection-config-error').textContent = state.configError
    ? '保存的连接配置无法使用；当前仅启动局域网连接。请重新填写服务地址；保存前会备份原配置，备份失败则不覆盖。' : '';
  document.getElementById('connection-backup').textContent = state.configBackup
    ? `原配置已备份到客户端数据目录：${state.configBackup}` : '';
  if (!connectionDirty) document.getElementById('relay-origin').value = state.relayOrigin || '';
  document.getElementById('connection-status').textContent = state.connectionRestartRequired
    ? '设置已保存。退出并重新打开 NoKey后生效；当前连接保持不变，更换服务后手机可能需要重新扫码更新连接地址。'
    : '保存后如有更改，请退出并重新打开 NoKey。';
  document.getElementById('uninstall').disabled = !state.uninstallAvailable;
  const devices = document.getElementById('devices');
  devices.replaceChildren();
  if (!state.devices?.length) devices.textContent = '尚无配对手机';
  for (const device of state.devices || []) {
    const row = document.createElement('p');
    const label = document.createElement('span');
    label.textContent = `手机 ${device.keyId.slice(0, 8)} · ${new Date(device.createdAt).toLocaleDateString()} `;
    const revoke = document.createElement('button');
    revoke.type = 'button'; revoke.textContent = '撤销配对';
    revoke.setAttribute('aria-label', `撤销手机 ${device.keyId.slice(0, 8)} 的配对`);
    revoke.onclick = async () => {
      revoke.disabled = true;
      try { renderDesktop(await window.desktopClient.action('revoke', device.keyId)); }
      catch (error) { document.getElementById('error').textContent = error.message; revoke.disabled = false; }
    };
    row.append(label, revoke); devices.append(row);
  }
  document.getElementById('qr').src = state.qr;
  renderNetwork();
  document.getElementById('device').textContent = state.deviceReady ? '虚拟麦克风已就绪'
    : '未检测到可用的虚拟麦克风，暂时无法接收手机声音。';
  document.getElementById('device-install-help').hidden = state.deviceReady;
  document.getElementById('device-select-help').hidden = !state.deviceReady;
  document.getElementById('device-code').textContent = `CoreAudio 检查码：${state.deviceStatus}；设备 UID：VoiceDeckMicrophone_UID。检查只确认系统能否找到设备，不代表目标应用已选用或已收到手机音频。`;
  const microphones = state.microphone?.devices || [];
  document.getElementById('microphone-current').textContent = `当前系统麦克风：${microphones.find(device => device.selected)?.name || '未知'}`;
  document.getElementById('microphone-message').textContent = state.microphone?.message || '';
  const choice = document.getElementById('microphone-choice');
  const selected = choice.value;
  choice.replaceChildren();
  for (const device of microphones.filter(device => device.uid !== 'VoiceDeckMicrophone_UID')) {
    const option = document.createElement('option'); option.value = device.uid; option.textContent = device.name;
    choice.append(option);
  }
  if ([...choice.options].some(option => option.value === selected)) choice.value = selected;
  document.getElementById('keyboard').textContent = state.keyboardEnabled ? '停用通用快捷键' : '启用通用快捷键';
  document.getElementById('keyboard-status').textContent = !state.keyboardEnabled ? '通用快捷键已停用；此开关不控制手机麦克风。'
    : state.keyboardTrusted ? '通用快捷键已启用；按键将发送到 Mac 当前前台应用。' : '通用快捷键已启用；请在系统设置中授权辅助功能，完成后点击“检查权限”。';
  renderExpiry();
};
window.desktopClient.onState(renderDesktop);
for (const action of ['refresh', 'pairing-copy', 'microphone-restore', 'microphone-select', 'keyboard', 'keyboard-permission', 'keyboard-check', 'device-check', 'stop-service', 'uninstall', 'login-enable', 'login-disable', 'login-check']) {
  const button = document.getElementById(action);
  button.addEventListener('click', async () => {
    button.disabled = true;
    document.getElementById('error').textContent = '';
    try {
      const state = await window.desktopClient.action(action, action === 'microphone-select' ? document.getElementById('microphone-choice').value : undefined);
      renderDesktop(state);
      if (action === 'keyboard-check') document.getElementById('error').textContent = state.keyboardTrusted
        ? '检查完成：系统辅助功能授权有效。'
        : '检查完成：系统尚未认可当前版本的授权。若设置中已开启，请退出本客户端，在辅助功能列表移除旧条目后重新添加 /Applications/NoKey.app，再打开客户端。无需重启 Mac。';
    }
    catch (error) { document.getElementById('error').textContent = error.message; }
    finally { button.disabled = (action === 'shortcuts' && Boolean(desktopState?.shortcuts)) || (action === 'uninstall' && !desktopState?.uninstallAvailable); if (action.startsWith('login-')) { try { renderDesktop(await window.desktopClient.action('state')); } catch {} } }
  });
}
setInterval(() => { renderExpiry(); renderNetwork(); }, 1000);
setInterval(renderAudio, 250);
renderAudio();

document.getElementById('relay-origin').addEventListener('input', () => { connectionDirty = true; });
document.getElementById('connection-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button = document.getElementById('connection-save');
  if (button.disabled) return;
  button.disabled = true;
  const input = document.getElementById('relay-origin');
  input.disabled = true;
  document.getElementById('error').textContent = '';
  try {
    const state = await window.desktopClient.action('connection-save', document.getElementById('relay-origin').value);
    connectionDirty = false; renderDesktop(state);
  } catch (error) { document.getElementById('error').textContent = error.message; }
  finally { button.disabled = false; input.disabled = false; }
});

const settings = document.getElementById('settings');
const toggle = document.getElementById('settings-toggle');
function showSettings(show) {
  settings.hidden = !show;
  document.getElementById('overview').hidden = show;
  toggle.textContent = show ? '返回' : '设置';
  toggle.setAttribute('aria-expanded', String(show));
  window.scrollTo(0, 0);
}
toggle.addEventListener('click', () => showSettings(settings.hidden));
document.getElementById('pair-open').addEventListener('click', () => {
  showSettings(true); document.getElementById('pair-section').scrollIntoView();
});
document.getElementById('restore-quick').addEventListener('click', () => document.getElementById('microphone-restore').click());
