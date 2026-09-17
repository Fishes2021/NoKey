type CaptureStream = { getTracks(): { onended: unknown; stop(): void }[]; release?(): void };
export type NativeAudioGate = {
  arm(): string;
  activate(id: string): boolean;
  stop(id: string): void;
  addListener(name: 'interrupted', callback: (event: { captureId: string; reason: string }) => void): { remove(): void };
};
export function createPhoneAudioCapture<T extends CaptureStream>(native: NativeAudioGate, getUserMedia: () => Promise<T>, onInterrupted: (message: string) => void): {
  getStream(): Promise<T>;
  stop(): void;
};
