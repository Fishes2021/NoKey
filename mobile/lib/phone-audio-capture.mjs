// SPDX-License-Identifier: GPL-3.0-only
// Native gate + track lifetime; shared with the interruption regression check.
export function createPhoneAudioCapture(native, getUserMedia, onInterrupted) {
  let captureId, stopped = false;
  const subscription = native.addListener('interrupted', event => {
    if (stopped || event.captureId !== captureId) return;
    try { stop(); }
    finally {
      onInterrupted(event.reason === 'input-disconnected'
        ? '音频输入设备已断开，请重新开始讲话'
        : '系统音频已中断，采音已停止；恢复后请点开始讲话');
    }
  });
  function release(value) {
    value?.getTracks().forEach(track => { track.onended = null; track.stop(); });
    value?.release?.();
  }
  function stop() {
    if (stopped) return;
    stopped = true;
    // Native capture closes before releasing JS tracks or waiting for a Mac response.
    try { if (captureId) native.stop(captureId); }
    finally { subscription.remove(); }
  }
  try { captureId = native.arm(); }
  catch (error) { stop(); throw error; }
  return {
    stop,
    async getStream() {
      if (stopped) throw new Error('本次采音已取消');
      try {
        const acquired = await getUserMedia();
        try {
          if (stopped || !native.activate(captureId) || stopped) throw new Error('系统音频已中断或采音已取消，请重新开始讲话');
          return acquired; // Ownership passes to VoiceSender; it releases tracks on stop.
        } catch (error) { release(acquired); throw error; }
      } catch (error) { stop(); throw error; }
    },
  };
}
