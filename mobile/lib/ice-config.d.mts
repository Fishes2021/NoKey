export type IceServer = { urls: string[]; username?: string; credential?: string };
export function validateIceConfig(value: unknown, now?: number): { iceServers: IceServer[]; expiresAt: number | null };
