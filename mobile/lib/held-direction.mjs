// One acknowledged movement at a time; releasing discards all future repeats.
export function createHeldDirection(send, schedule = setTimeout, cancel = clearTimeout) {
  let generation = 0, timer, direction = null, inFlight = null;
  const stop = () => { generation++; direction = null; cancel(timer); };
  return {
    stop,
    set(next) {
      if (next === direction) return;
      stop(); if (!next) return;
      direction = next; const run = generation;
      const step = async repeat => {
        if (run !== generation) return;
        if (inFlight) { await inFlight.catch(() => {}); if (run !== generation) return; }
        let ok = false;
        const work = Promise.resolve().then(() => run === generation ? send(next, repeat) : false); inFlight = work;
        try { ok = await work; } catch { /* Stop on failure; no queued input. */ }
        if (inFlight === work) inFlight = null;
        if (run !== generation) return;
        if (!ok) { stop(); return; }
        timer = schedule(() => void step(true), repeat ? 90 : 350);
      };
      void step(false);
    },
  };
}
