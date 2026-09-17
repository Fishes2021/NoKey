// SPDX-License-Identifier: GPL-3.0-only
class VoicePCM extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(960);
    this.offset = 0;
  }
  process(inputs) {
    const channels = inputs[0];
    if (!channels?.length) return true;
    const left = channels[0], right = channels[1] || left;
    for (let i = 0; i < left.length; i++) {
      this.buffer[this.offset++] = left[i];
      this.buffer[this.offset++] = right[i];
      if (this.offset === this.buffer.length) {
        this.port.postMessage(this.buffer, [this.buffer.buffer]);
        this.buffer = new Float32Array(960);
        this.offset = 0;
      }
    }
    // Outputs remain zero. Decoded audio goes only to the native virtual device.
    return true;
  }
}
registerProcessor('voice-pcm', VoicePCM);
