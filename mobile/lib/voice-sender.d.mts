export type VoiceState = 'idle' | 'connecting' | 'speaking' | 'reconnecting' | 'error';
export type VoiceTelemetry = { inputSelected?: boolean; inputError?: string; received: boolean | null; level: number | null; peak: number | null };
export class VoiceSender {
  constructor(options: {
    createPeer: (configuration: { iceServers: { urls: string | string[]; username?: string; credential?: string }[] }) => unknown;
    getIceConfig?: () => Promise<{ iceServers: { urls: string | string[]; username?: string; credential?: string }[]; expiresAt: number | null }>;
    stopCapture?: () => void;
    getStream: () => Promise<unknown>;
    request: (path: string, body: Record<string, unknown>) => Promise<any>;
    onState?: (state: VoiceState, message?: string) => void;
    onStats?: (stats: VoiceTelemetry) => void;
    gain?: number;
    iceServers?: { urls: string | string[]; username?: string; credential?: string }[];
  });
  current: unknown;
  start(): Promise<void>;
  setGain(value: number): Promise<void>;
  restart(): Promise<void>;
  interrupt(message?: string): void;
  stop(): Promise<void>;
}
