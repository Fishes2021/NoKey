import { randomUUID } from 'node:crypto';

const START_OBSERVATION_TIMEOUT_MS = 8_000;

function threadIsBusy(state, threadId) {
  const thread = state?.threads?.find((entry) => entry.id === threadId);
  return thread?.status === 'thinking';
}

export class RemoteMessageQueue {
  #items = [];
  #lifetime = new AbortController();
  #ownership = new WeakMap();
  #activeDispatch = null;
  #draining = false;
  #startTimer = null;
  #getState;
  #send;
  #onChange;
  #makeId;
  #now;

  constructor({
    getState,
    send,
    onChange = () => {},
    makeId = randomUUID,
    now = Date.now,
  }) {
    this.#getState = getState;
    this.#send = send;
    this.#onChange = onChange;
    this.#makeId = makeId;
    this.#now = now;
  }

  list() {
    return this.#items.map((item) => ({ ...item }));
  }

  enqueue({ threadId, text, owner = null, controlTicket = null }) {
    if (this.#lifetime.signal.aborted) throw Object.assign(new Error('客户端已停止'), { statusCode: 503 });
    const cleanThreadId = String(threadId || '').trim();
    const cleanText = String(text || '').trim();
    if (!cleanThreadId) throw Object.assign(new Error('Missing threadId.'), { statusCode: 400 });
    if (!cleanText) throw Object.assign(new Error('Message cannot be empty.'), { statusCode: 400 });
    if (cleanText.length > 12_000) {
      throw Object.assign(new Error('Message is too long.'), { statusCode: 400 });
    }

    const item = {
      id: this.#makeId(),
      threadId: cleanThreadId,
      text: cleanText,
      status: 'queued',
      createdAt: this.#now(),
    };
    this.#ownership.set(item, { owner, controlTicket, controller: new AbortController() });
    this.#items.push(item);
    this.#onChange();
    queueMicrotask(() => void this.drain());
    return { ...item };
  }

  remove(id) {
    const index = this.#items.findIndex(
      (item) => item.id === id && item.status === 'queued',
    );
    if (index < 0) return false;
    this.#items.splice(index, 1);
    this.#onChange();
    return true;
  }

  removeThread(threadId) {
    const target = String(threadId || '').trim();
    if (!target) return 0;
    const previousLength = this.#items.length;
    this.#items = this.#items.filter(
      (item) => item.threadId !== target || item.status !== 'queued',
    );
    const removed = previousLength - this.#items.length;
    if (removed) this.#onChange();
    return removed;
  }

  revoke(owner) {
    if (!owner) return;
    const removed = this.#items.filter(item => this.#ownership.get(item).owner === owner);
    for (const item of removed) this.#ownership.get(item).controller.abort();
    this.#items = this.#items.filter(item => !removed.includes(item));
    if (removed.some(item => item.id === this.#activeDispatch?.messageId)) this.#completeActiveDispatch();
    if (removed.length) this.#onChange();
  }

  async handleCodexChange() {
    if (this.#lifetime.signal.aborted) return;
    let state;
    try { state = await this.#getState(); }
    catch {
      if (this.#lifetime.signal.aborted) return;
      // A subscription is fire-and-forget. Contain transport failures here and
      // pause waiting messages instead of replaying them after reconnection.
      for (const item of this.#items) {
        if (item.status === 'queued' && !item.error) item.error = 'Codex 状态读取失败，消息已暂停；请检查 Mac 后重新操作';
      }
      this.#onChange();
      return;
    }
    if (this.#lifetime.signal.aborted) return;
    if (this.#activeDispatch) {
      if (threadIsBusy(state, this.#activeDispatch.threadId)) {
        this.#activeDispatch.sawBusy = true;
      } else if (this.#activeDispatch.sawBusy) {
        this.#completeActiveDispatch();
      }
    }
    await this.drain(state);
  }

  async drain(knownState) {
    if (this.#lifetime.signal.aborted || this.#draining || this.#activeDispatch || !this.#items.length) return;
    const item = this.#items[0];
    // A failed reply may follow a successful side effect. Only a new user action may resend.
    if (!item || item.error) return;
    const signal = AbortSignal.any([this.#lifetime.signal, this.#ownership.get(item).controller.signal]);
    this.#draining = true;
    try {
      const state = knownState ?? await this.#getState();
      if (signal.aborted || item.error || !this.#items.includes(item) || threadIsBusy(state, item.threadId)) return;

      item.status = 'sending';
      delete item.error;
      this.#onChange();
      await this.#send({ ...item }, signal, this.#ownership.get(item).owner, this.#ownership.get(item).controlTicket);
      if (signal.aborted) return;
      this.#activeDispatch = {
        messageId: item.id,
        threadId: item.threadId,
        sawBusy: false,
      };
      this.#armStartObservation();
      this.#onChange();
    } catch (error) {
      if (signal.aborted) return;
      item.status = 'queued';
      item.error = error?.message || 'Message could not be sent.';
      this.#onChange();
    } finally {
      this.#draining = false;
    }
  }

  #armStartObservation() {
    if (this.#startTimer) clearTimeout(this.#startTimer);
    this.#startTimer = setTimeout(() => {
      this.#startTimer = null;
      if (!this.#activeDispatch?.sawBusy) {
        this.#completeActiveDispatch();
        void this.drain();
      }
    }, START_OBSERVATION_TIMEOUT_MS);
  }

  #completeActiveDispatch() {
    if (this.#startTimer) clearTimeout(this.#startTimer);
    this.#startTimer = null;
    const messageId = this.#activeDispatch?.messageId;
    if (messageId) {
      const index = this.#items.findIndex(
        (item) => item.id === messageId && item.status === 'sending',
      );
      if (index >= 0) this.#items.splice(index, 1);
    }
    this.#activeDispatch = null;
    this.#onChange();
  }

  close() {
    this.#lifetime.abort();
    this.#items = [];
    this.#activeDispatch = null;
    if (this.#startTimer) clearTimeout(this.#startTimer);
    this.#startTimer = null;
  }
}
