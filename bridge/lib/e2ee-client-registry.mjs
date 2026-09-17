import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

import {
  E2EEEnvelopeError,
  normalizeE2EEKeyMaterial,
  openE2EE,
  sealE2EE,
  toBase64Url,
} from './e2ee.mjs';

const REGISTRY_FILE = 'e2ee-clients.json';
const REGISTRY_VERSION = 1;
const MAX_CLIENTS = 12;
const SESSION_TTL_MS = 30 * 60 * 1000;
const MESSAGE_CLOCK_SKEW_MS = 5 * 60 * 1000;
const MAX_SEEN_MESSAGES = 2_048;

const ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

export class E2EEAuthenticationError extends Error {
  constructor(message = 'Encrypted Microdex authentication failed.') {
    super(message);
    this.name = 'E2EEAuthenticationError';
    this.statusCode = 401;
  }
}

export class E2EESessionError extends Error {
  constructor(message = 'The encrypted Microdex session expired.') {
    super(message);
    this.name = 'E2EESessionError';
    this.statusCode = 409;
    this.code = 'E2EE_SESSION_EXPIRED';
  }
}

function validTimestamp(value, now) {
  return Number.isFinite(value) && Math.abs(now - Number(value)) <= MESSAGE_CLOCK_SKEW_MS;
}

function validRequestId(value) {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

export class E2EEClientRegistry {
  #stateDir;
  #registryPath;
  #clients = new Map();
  #sessions = new Map();
  #loaded = null;
  #now;
  #randomBytes;
  #writes = Promise.resolve();
  #revoked = new Set();

  constructor({ stateDir, now = Date.now, randomBytesImpl = randomBytes }) {
    this.#stateDir = stateDir;
    this.#registryPath = path.join(stateDir, REGISTRY_FILE);
    this.#now = now;
    this.#randomBytes = randomBytesImpl;
  }

  async #load() {
    if (this.#loaded) return this.#loaded;
    this.#loaded = (async () => {
      try {
        const saved = JSON.parse(await readFile(this.#registryPath, 'utf8'));
        if (saved?.version !== REGISTRY_VERSION || !Array.isArray(saved.clients)) {
          throw new Error('The encrypted client registry is invalid.');
        }
        for (const entry of saved.clients.slice(0, MAX_CLIENTS)) {
          const material = normalizeE2EEKeyMaterial(entry);
          this.#clients.set(material.keyId, {
            ...material,
            createdAt: Number(entry.createdAt) || this.#now(),
          });
        }
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    })();
    return this.#loaded;
  }

  async #persist() {
    await mkdir(this.#stateDir, { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.#registryPath}.${process.pid}.tmp`;
    const payload = {
      version: REGISTRY_VERSION,
      clients: [...this.#clients.values()],
    };
    const data = `${JSON.stringify(payload)}\n`;
    const write = this.#writes.catch(() => {}).then(async () => {
      await writeFile(temporaryPath, data, { mode: 0o600 });
      await rename(temporaryPath, this.#registryPath);
    });
    this.#writes = write;
    await write;
  }

  #pruneSessions() {
    const now = this.#now();
    for (const [sessionId, session] of this.#sessions) {
      if (session.expiresAt <= now) this.#sessions.delete(sessionId);
    }
  }

  async addClient(materialValue) {
    await this.#load();
    const material = normalizeE2EEKeyMaterial(materialValue);
    this.#clients.delete(material.keyId);
    this.#clients.set(material.keyId, { ...material, createdAt: this.#now() });
    while (this.#clients.size > MAX_CLIENTS) {
      const oldest = this.#clients.keys().next().value;
      this.#remove(oldest);
    }
    await this.#persist();
    return material;
  }

  subscribeRevoked(listener) {
    this.#revoked.add(listener);
    return () => this.#revoked.delete(listener);
  }

  async listClients() {
    await this.#load();
    return [...this.#clients.values()].map(({ keyId, createdAt }) => ({ keyId, createdAt }));
  }

  #remove(keyId) {
    if (!this.#clients.delete(keyId)) return false;
    for (const [id, session] of this.#sessions) if (session.keyId === keyId) this.#sessions.delete(id);
    for (const listener of this.#revoked) listener(keyId);
    return true;
  }

  async removeClient(keyId) {
    await this.#load();
    if (typeof keyId !== 'string' || !ID_PATTERN.test(keyId)) throw new E2EEAuthenticationError();
    const removed = this.#remove(keyId);
    await this.#persist();
    return removed;
  }

  async materialFor(keyId) {
    await this.#load();
    const material = this.#clients.get(String(keyId ?? '').trim());
    if (!material) throw new E2EEAuthenticationError();
    return { keyId: material.keyId, key: material.key };
  }

  async createSession(envelope, authenticate) {
    const material = await this.materialFor(envelope?.keyId);
    let payload;
    try {
      payload = openE2EE(material, 'session', envelope);
    } catch (error) {
      if (error instanceof E2EEEnvelopeError) throw new E2EEAuthenticationError();
      throw error;
    }
    if (this.#clients.get(material.keyId)?.key !== material.key) throw new E2EEAuthenticationError();
    const now = this.#now();
    if (
      !validRequestId(payload.requestId) ||
      !validTimestamp(payload.issuedAt, now) ||
      !authenticate(String(payload.token ?? ''))
    ) {
      throw new E2EEAuthenticationError();
    }
    this.#pruneSessions();
    const sessionId = toBase64Url(this.#randomBytes(24));
    const expiresAt = now + SESSION_TTL_MS;
    this.#sessions.set(sessionId, {
      keyId: material.keyId,
      expiresAt,
      seen: new Set(),
    });
    return {
      material,
      requestId: payload.requestId,
      sessionId,
      expiresAt,
      envelope: sealE2EE(material, `session-response:${payload.requestId}`, {
        sessionId,
        expiresAt,
      }, this.#randomBytes),
    };
  }

  async openSessionMessage(envelope, purpose) {
    this.#pruneSessions();
    const sessionId = String(envelope?.sessionId ?? '').trim();
    if (!ID_PATTERN.test(sessionId)) throw new E2EESessionError();
    const session = this.#sessions.get(sessionId);
    if (!session || session.keyId !== envelope?.keyId) throw new E2EESessionError();
    const material = await this.materialFor(session.keyId);
    if (this.#sessions.get(sessionId) !== session || this.#clients.get(material.keyId)?.key !== material.key) throw new E2EESessionError();
    let payload;
    try {
      payload = openE2EE(material, `${purpose}:${sessionId}`, envelope);
    } catch (error) {
      if (error instanceof E2EEEnvelopeError) throw new E2EEAuthenticationError();
      throw error;
    }
    const now = this.#now();
    if (!validRequestId(payload.requestId) || !validTimestamp(payload.issuedAt, now)) {
      throw new E2EEAuthenticationError();
    }
    if (session.seen.has(payload.requestId)) {
      throw new E2EEAuthenticationError('Encrypted Microdex message was already used.');
    }
    if (session.seen.size >= MAX_SEEN_MESSAGES) {
      this.#sessions.delete(sessionId);
      throw new E2EESessionError('The encrypted Microdex session reached its safe message limit.');
    }
    session.seen.add(payload.requestId);
    return { material, sessionId, requestId: payload.requestId, payload };
  }

  #assertActive(context) {
    const session = this.#sessions.get(context.sessionId);
    if (!session || session.expiresAt <= this.#now() || session.keyId !== context.material.keyId ||
        this.#clients.get(context.material.keyId)?.key !== context.material.key) throw new E2EESessionError();
  }

  assertActive(context) { this.#assertActive(context); }

  sealResponse(context, payload) {
    this.#assertActive(context);
    return sealE2EE(
      context.material,
      `response:${context.sessionId}:${context.requestId}`,
      payload,
      this.#randomBytes,
    );
  }

  sealEvent(context, payload) {
    this.#assertActive(context);
    return sealE2EE(
      context.material,
      `event:${context.sessionId}`,
      {
        eventId: toBase64Url(this.#randomBytes(16)),
        issuedAt: this.#now(),
        payload,
      },
      this.#randomBytes,
    );
  }
}
