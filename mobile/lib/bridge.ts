import Constants from 'expo-constants';
import { ConnectionRoutes } from './connection-routes.mjs';
import { normalizeBridgeUrl } from './pairing.ts';

import {
  type E2EEEnvelope,
  type E2EEKeyMaterial,
  openE2EE,
} from './e2ee-core.ts';
import { randomE2EEId, sealMobileE2EE } from './e2ee.ts';

/** Max and Ultra are excluded: see REASONING_EFFORTS in bridge/lib/codex-config.mjs. */
export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';

export type ActionAvailability = {
  status: 'available' | 'contextual' | 'unavailable';
  reason: string | null;
};

export type RemoteThread = {
  id: string;
  name: string;
  task: string;
  project: string;
  status: 'idle' | 'thinking' | 'waiting' | 'error' | 'complete';
  updatedAt: number;
  fastMode: boolean;
  reasoningEffort: ReasoningEffort;
  supportedReasoningEfforts: ReasoningEffort[];
};

export type QueuedMessage = {
  id: string;
  threadId: string;
  text: string;
  status: 'queued' | 'sending';
  createdAt: number;
  error?: string;
};

export type RemoteState = {
  online: boolean;
  selectedThreadId: string | null;
  selected: RemoteThread | null;
  threads: RemoteThread[];
  messageQueue: QueuedMessage[];
  pendingApproval: {
    requestId: string;
    threadId: string;
    reason: string | null;
    command: string | null;
  } | null;
  actionAvailability?: Record<string, ActionAvailability>;
  voice?: {
    state: 'inactive' | 'launching' | 'setup' | 'active';
    muted: boolean;
  };
  commandResult?: {
    action: string;
    applied: boolean;
    verified: boolean;
    /** The App Server read the new state back. Absent on older bridges. */
    confirmed?: boolean;
    evidence: 'codex' | 'desktop';
    desktopMirrored: boolean;
    warning: string | null;
  } | null;
  hardware?: {
    mode: 'native' | 'standard';
    available: boolean;
    connected: boolean;
    battery: number | null;
    lighting: {
      rgb: {
        keys: unknown;
        ambient: number | null;
      } | null;
      threads: Array<{
        id: number | null;
        color: number | null;
        enabled: number | null;
        effect: number | null;
      }> | null;
    };
  };
};

export type BridgeStatus = {
  connected: true;
  device?: { name: string };
  bridge?: {
    name: string;
    version: string;
    protocolVersion: number;
  };
  capabilities?: {
    verifiedSettings: boolean;
    remoteChat: boolean;
    taskControl: boolean;
    programmableActions: number;
    programmableAssignments?: boolean;
    encoderModes?: boolean;
    desktopAutomation: boolean;
    actionAvailability: boolean;
    visibleDesktopRouting?: boolean;
    nativeHardware?: boolean;
    endToEndEncryption?: boolean;
  };
  connection?: {
    remoteAccess: string;
    remoteReady: boolean;
    transport: 'relay' | 'https' | 'local';
  };
  fastMode: boolean;
  reasoningEffort: ReasoningEffort;
  configPath: string;
  platform: string;
  desktop?: {
    available?: boolean;
    trusted?: boolean;
    running?: boolean;
    error?: string;
    reason?: string;
  };
  remote: RemoteState | { online: false; error: string } | null;
};

type RequestOptions = {
  method?: 'GET' | 'POST';
  body?: Record<string, unknown>;
  timeoutMs?: number;
  signal?: AbortSignal;
};

type E2EESession = {
  sessionId: string;
  expiresAt: number;
};

const e2eeSessions = new Map<string, Promise<E2EESession>>();
const seenEventIds = new Map<string, Set<string>>();
const registeredEncryption = new Map<string, E2EEKeyMaterial>();

function normalizedBridgeKey(bridgeUrl: string) {
  return bridgeUrl.trim().replace(/\/$/, '');
}

export function registerBridgeEncryption(
  bridgeUrl: string,
  material: E2EEKeyMaterial | null,
) {
  const key = normalizedBridgeKey(bridgeUrl);
  const previous = registeredEncryption.get(key);
  if (previous) clearE2EESession(key, previous);
  if (material) registeredEncryption.set(key, material);
  else registeredEncryption.delete(key);
}

function e2eeSessionKey(bridgeUrl: string, material: E2EEKeyMaterial) {
  return `${bridgeUrl.replace(/\/$/, '')}:${material.keyId}`;
}

function clearE2EESession(bridgeUrl: string, material: E2EEKeyMaterial) {
  const key = e2eeSessionKey(bridgeUrl, material);
  e2eeSessions.delete(key);
  seenEventIds.delete(key);
}

async function ensureE2EESession(
  bridgeUrl: string,
  token: string,
  material: E2EEKeyMaterial,
  signal?: AbortSignal,
) {
  const key = e2eeSessionKey(bridgeUrl, material);
  const existing = e2eeSessions.get(key);
  if (existing) {
    const session = await existing;
    if (session.expiresAt > Date.now() + 10_000) return session;
    clearE2EESession(bridgeUrl, material);
  }

  const pending = (async () => {
    const requestId = await randomE2EEId();
    const envelope = await sealMobileE2EE(material, 'session', {
      requestId,
      issuedAt: Date.now(),
      token,
    });
    const response = await fetch(`${bridgeUrl.replace(/\/$/, '')}/api/e2ee/session`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ envelope }),
      signal,
    });
    const result = (await response.json()) as {
      envelope?: E2EEEnvelope;
      error?: string;
      code?: string;
    };
    if (!response.ok || !result.envelope) {
      if (response.status === 401) {
        throw new BridgeAuthError(
          '此 Mac 已拒绝当前配对。请在 Mac 客户端刷新二维码，再用手机重新配对。',
        );
      }
      throw bridgeErrorForStatus(response.status, result);
    }
    const payload = openE2EE<E2EESession>(
      material,
      `session-response:${requestId}`,
      result.envelope,
    );
    if (
      !/^[A-Za-z0-9_-]{16,64}$/.test(payload.sessionId) ||
      !Number.isFinite(payload.expiresAt) ||
      payload.expiresAt <= Date.now()
    ) {
      throw new BridgeAuthError('Mac 返回的加密会话无效，请在 Mac 客户端刷新二维码后重新配对。');
    }
    return payload;
  })();
  e2eeSessions.set(key, pending);
  try {
    return await pending;
  } catch (error) {
    if (e2eeSessions.get(key) === pending) e2eeSessions.delete(key);
    throw error;
  }
}

function bridgeErrorForStatus(status: number, payload: { error?: string; code?: string }) {
  const message = payload.error ?? `Bridge error ${status}`;
  if (status === 401) {
    return new BridgeAuthError(
      payload.code === 'E2EE_REQUIRED'
        ? '保存的旧配对不支持加密连接。请更新 Mac 客户端并刷新二维码，再用手机重新配对。'
        : '此 Mac 已拒绝保存的授权。请在 Mac 客户端刷新二维码，再用手机重新配对。',
    );
  }
  if (payload.code === 'RELAY_SUBSCRIPTION_REQUIRED' || payload.code === 'RELAY_INACTIVE') {
    return Object.assign(new BridgeConnectionError('中继服务尚未授权、已到期或已停用。请在 Mac 查看授权；局域网仍可使用。'), { code: payload.code });
  }
  if (status === 503 && payload.code === 'MAC_OFFLINE') {
    return Object.assign(new BridgeConnectionError(
      'Mac 未连接，请唤醒 Mac 并打开 NoKey。',
    ), { code: 'MAC_OFFLINE' });
  }
  return Object.assign(new Error(message), { statusCode: status });
}

export class BridgeConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BridgeConnectionError';
  }
}

/**
 * The bridge is reachable but rejected the stored credential. Retrying cannot
 * help: only pairing again can.
 *
 * On iOS the Keychain survives an app uninstall, so a reinstalled app comes back
 * holding a token the Mac may no longer accept. Treated as a plain connection
 * error, that looked exactly like a flaky network and the app retried forever
 * without ever saying the credential was the problem.
 *
 * Extends BridgeConnectionError so existing checks keep working.
 */
export class BridgeAuthError extends BridgeConnectionError {
  constructor(message: string) {
    super(message);
    this.name = 'BridgeAuthError';
  }
}

export function isBridgeConnectionError(error: unknown) {
  return error instanceof BridgeConnectionError;
}

export function isBridgeAuthError(error: unknown) {
  return error instanceof BridgeAuthError;
}

export function inferBridgeUrl() {
  const hostUri = Constants.expoConfig?.hostUri;
  const withoutProtocol = hostUri?.replace(/^[a-z]+:\/\//i, '');
  const host = withoutProtocol?.startsWith('[')
    ? withoutProtocol.slice(1, withoutProtocol.indexOf(']'))
    : withoutProtocol?.split(':')[0];
  return host ? `http://${host}:3210` : 'http://192.168.1.10:3210';
}

export function mobileAppInfo() {
  return {
    version: Constants.expoConfig?.version ?? 'unknown',
    buildNumber: Constants.expoConfig?.ios?.buildNumber ?? 'unknown',
  };
}

export function bridgeEventsUrl(bridgeUrl: string) {
  const url = new URL(bridgeUrl.replace(/\/$/, ''));
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const basePath = url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '');
  url.pathname = `${basePath}/api/remote/events`;
  url.search = '';
  url.hash = '';
  return url.toString();
}

export async function bridgeEventAuthentication(
  bridgeUrl: string,
  token: string,
  material: E2EEKeyMaterial,
) {
  const session = await ensureE2EESession(bridgeUrl, token, material);
  const requestId = await randomE2EEId();
  const envelope = await sealMobileE2EE(
    material,
    `events-auth:${session.sessionId}`,
    { type: 'events-auth', requestId, issuedAt: Date.now() },
  );
  return {
    sessionId: session.sessionId,
    message: {
      type: 'e2ee-auth' as const,
      envelope: { ...envelope, sessionId: session.sessionId },
    },
  };
}

export function openBridgeEvent(
  bridgeUrl: string,
  material: E2EEKeyMaterial,
  sessionId: string,
  envelope: E2EEEnvelope,
) {
  const event = openE2EE<{
    eventId: string;
    issuedAt: number;
    payload: { type: 'state' | 'error'; state?: RemoteState; message?: string };
  }>(material, `event:${sessionId}`, envelope);
  if (
    !/^[A-Za-z0-9_-]{16,64}$/.test(event.eventId) ||
    !Number.isFinite(event.issuedAt) ||
    Math.abs(Date.now() - event.issuedAt) > 5 * 60 * 1000
  ) {
    throw new BridgeAuthError('An invalid encrypted live update was rejected.');
  }
  const key = e2eeSessionKey(bridgeUrl, material);
  const seen = seenEventIds.get(key) ?? new Set<string>();
  if (seen.has(event.eventId)) throw new BridgeAuthError('A replayed live update was rejected.');
  seen.add(event.eventId);
  if (seen.size > 2_048) seen.delete(seen.values().next().value as string);
  seenEventIds.set(key, seen);
  return event.payload;
}

export function resetEncryptedBridgeSession(
  bridgeUrl: string,
  material: E2EEKeyMaterial,
) {
  clearE2EESession(bridgeUrl, material);
}

async function directBridgeRequest<T>(
  bridgeUrl: string,
  token: string,
  path: string,
  options: RequestOptions = {},
  e2ee?: E2EEKeyMaterial | null,
) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  options.signal?.addEventListener('abort', cancel, { once: true });
  if (options.signal?.aborted) cancel();
  const timeout = setTimeout(cancel, options.timeoutMs ?? 20_000);
  const encryption = e2ee ?? registeredEncryption.get(normalizedBridgeKey(bridgeUrl));

  try {
    if (encryption) {
      const encryptedRequest = async (retrySession: boolean): Promise<T> => {
        const session = await ensureE2EESession(bridgeUrl, token, encryption, controller.signal);
        const requestId = await randomE2EEId();
        const envelope = await sealMobileE2EE(encryption, `request:${session.sessionId}`, {
          requestId,
          issuedAt: Date.now(),
          method: options.method ?? 'GET',
          path,
          body: options.body,
        });
        const response = await fetch(`${bridgeUrl.replace(/\/$/, '')}/api/e2ee`, {
          method: 'POST',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
          body: JSON.stringify({ envelope: { ...envelope, sessionId: session.sessionId } }),
          signal: controller.signal,
        });
        const outer = (await response.json()) as {
          envelope?: E2EEEnvelope;
          error?: string;
          code?: string;
        };
        if (response.status === 409 && outer.code === 'E2EE_SESSION_EXPIRED') {
          clearE2EESession(bridgeUrl, encryption);
          if (retrySession) return encryptedRequest(false);
          throw new BridgeConnectionError('连接会话已失效，操作结果未确认；请先检查 Mac，系统不会自动重发。');
        }
        if (!response.ok || !outer.envelope) throw bridgeErrorForStatus(response.status, outer);
        const decrypted = openE2EE<{
          status: number;
          contentType?: string;
          body: string;
        }>(encryption, `response:${session.sessionId}:${requestId}`, outer.envelope);
        let payload: T & { error?: string; code?: string };
        try {
          payload = JSON.parse(decrypted.body) as T & { error?: string; code?: string };
        } catch {
          throw new BridgeConnectionError('Mac 返回了无效的加密响应，本次结果未确认。');
        }
        if (decrypted.status < 200 || decrypted.status >= 300) {
          throw bridgeErrorForStatus(decrypted.status, payload);
        }
        return payload;
      };
      // Expiry may be reported while sealing a response, after a side effect ran.
      // Only reads can safely be repeated with a new session and request ID.
      return await encryptedRequest((options.method ?? 'GET') === 'GET');
    }

    const response = await fetch(`${bridgeUrl.replace(/\/$/, '')}${path}`, {
      method: options.method ?? 'GET',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-Microdex-Token': token.trim(),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });

    const payload = (await response.json()) as T & { error?: string; code?: string };
    if (!response.ok) {
      throw bridgeErrorForStatus(response.status, payload);
    }
    return payload;
  } catch (error) {
    if (error instanceof BridgeConnectionError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new BridgeConnectionError(
        'Mac 客户端暂未响应。请检查两端网络，并保持语音快捷键盘在 Mac 上运行。',
      );
    }
    if (error instanceof TypeError) {
      throw new BridgeConnectionError(
        '连接已中断，请检查手机和 Mac 的网络。',
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', cancel);
  }
}

let discoverBridges: (signal: AbortSignal) => Promise<string[]> = async () => [];
export function setBridgeDiscovery(discover: typeof discoverBridges) { discoverBridges = discover; }
const routeStates = new Map<string, ConnectionRoutes>();
const routeListeners = new Set<(keyId: string, addresses: string[]) => void>();
export function onBridgeRoutesChanged(listener: (keyId: string, addresses: string[]) => void) {
  routeListeners.add(listener); return () => { routeListeners.delete(listener); };
}
export function configureBridgeRoutes(base: string, token: string, material: E2EEKeyMaterial, candidates: unknown) {
  if (!Array.isArray(candidates) || candidates.length > 12) return;
  let addresses: string[];
  try { addresses = [...new Set([base, ...candidates].map(value => normalizeBridgeUrl(String(value))))].slice(0, 12); }
  catch { return; }
  const key = material.keyId;
  const previous = routeStates.get(key);
  if (previous) {
    if (JSON.stringify(previous.routes) === JSON.stringify(addresses)) return;
    previous.update(addresses);
  } else {
    routeStates.set(key, new ConnectionRoutes(addresses, async (address, signal) => {
      const response = await directBridgeRequest<{ routes?: string[] }>(address, token, '/api/connection', { signal, timeoutMs: 2500 }, material);
      if (response.routes) configureBridgeRoutes(base, token, material, response.routes);
    }, signal => discoverBridges(signal)));
  }
  for (const listener of routeListeners) listener(key, addresses);
}
export function resetBridgeRoute(material: E2EEKeyMaterial | null, active = true) { if (material) routeStates.get(material.keyId)?.reset(active); }
export function currentBridgeRoute(material: E2EEKeyMaterial | null) { return material ? routeStates.get(material.keyId)?.selected ?? null : null; }
export async function bridgeRequest<T>(base: string, token: string, path: string, options: RequestOptions = {}, e2ee?: E2EEKeyMaterial | null): Promise<T> {
  const material = e2ee ?? registeredEncryption.get(normalizedBridgeKey(base));
  if (!material) return directBridgeRequest(base, token, path, options, e2ee);
  const router = routeStates.get(material.keyId);
  // Legacy bindings learn routes on their first successful authenticated response.
  const request = async (address: string) => {
    const result = await directBridgeRequest<T & { routes?: string[] }>(address, token, path, options, material);
    if (result?.routes) configureBridgeRoutes(base, token, material, result.routes);
    return result;
  };
  if (!router) return request(base);
  const address = path === '/api/voice/stop' ? router.selected || router.lastSelected || base : await router.select(options.signal);
  try { return await request(address); }
  catch (error) {
    if (options.signal?.aborted || !router.active) throw error;
    const safe = (options.method ?? 'GET') === 'GET' || ['/api/keyboard/target', '/api/voice/config', '/api/voice/status'].includes(path);
    if (!(error instanceof BridgeConnectionError) && !(error instanceof TypeError)) throw error;
    router.reset();
    if (!safe) throw error; // Never replay a key, text, pairing claim or voice toggle.
    return request(await router.select(options.signal));
  }
}
