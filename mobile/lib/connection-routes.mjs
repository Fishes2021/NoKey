// One paired identity, multiple authenticated paths. No background polling.
export class ConnectionRoutes {
  constructor(routes, probe, discover = async () => []) { this.discover = discover; this.lastSelected = null; this.routes = routes; this.probe = probe; this.selected = null; this.pending = null; this.controller = null; this.active = true; }
  update(routes) { this.routes = routes; }
  reset(active = this.active) {
    this.active = active; this.selected = null; this.controller?.abort(); this.pending = null;
  }
  async select(signal) {
    if (!this.active || signal?.aborted) throw new Error('连接检查已暂停');
    if (this.selected) return this.selected;
    if (!this.pending) {
      const controller = new AbortController(); this.controller = controller;
      const timeout = setTimeout(() => controller.abort(), 2800);
      const selection = (async () => {
        const attempt = async address => {
          // Give local paths a small head start, then race the remote path.
          if (address.startsWith('https:') && this.routes.some(url => url.startsWith('http:'))) {
            await new Promise((resolve, reject) => {
              const cancel = () => { clearTimeout(timer); reject(new Error('连接检查已取消')); };
              const timer = setTimeout(() => { controller.signal.removeEventListener('abort', cancel); resolve(); }, 250);
              controller.signal.addEventListener('abort', cancel, { once: true });
              if (controller.signal.aborted) cancel();
            });
          }
          if (controller.signal.aborted) throw new Error('连接检查已取消');
          await this.probe(address, controller.signal);
          if (controller.signal.aborted) throw new Error('连接检查已取消');
          return address;
        };
        const attempts = this.routes.map(attempt);
        attempts.push(this.discover(controller.signal).then(addresses => Promise.any(addresses.filter(address => !this.routes.includes(address)).slice(0, 12).map(attempt))));
        try {
          const address = await Promise.any(attempts);
          if (controller.signal.aborted || this.controller !== controller || !this.active) throw new Error('连接检查已取消');
          this.selected = address; this.lastSelected = address; return address;
        } catch (error) {
          if (error instanceof AggregateError) {
            // A forged/expired response on one route must not invalidate another valid route.
            const errors = error.errors.flatMap(e => e instanceof AggregateError ? e.errors : [e]);
            throw errors.find(e => e?.code === 'RELAY_SUBSCRIPTION_REQUIRED') || errors.find(e => e?.code === 'MAC_OFFLINE') || errors.find(e => e?.name !== 'BridgeAuthError') || errors[0] || error;
          }
          throw error;
        } finally { clearTimeout(timeout); controller.abort(); }
      })();
      this.pending = selection;
      void selection.finally(() => { if (this.pending === selection) this.pending = null; }).catch(() => {});
    }
    const pending = this.pending;
    if (!signal) return pending;
    return new Promise((resolve, reject) => {
      const cancel = () => reject(new Error('连接检查已取消'));
      signal.addEventListener('abort', cancel, { once: true });
      pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel));
      if (signal.aborted) cancel();
    });
  }
}
