import test from 'node:test';
import assert from 'node:assert/strict';
import { createHeldDirection } from '../lib/held-direction.mjs';
test('hold repeats only after acknowledgement, release cancels, and direction changes never queue old input', async () => {
  let next = 0, settle;
  const timers = new Map(), calls = [];
  const hold = createHeldDirection((direction, repeat) => { calls.push([direction,repeat]); return new Promise(resolve => {settle=resolve;}); },
    (fn,ms) => {const id=++next;timers.set(id,{fn,ms});return id;}, id => timers.delete(id));
  const flush = async () => { for(let i=0;i<8;i++) await Promise.resolve(); };
  hold.set('right'); await flush(); assert.equal(calls.length,1); assert.equal(timers.size,0);
  settle(true); await flush(); let [id,timer]=[...timers][0]; assert.equal(timer.ms,350);
  timers.delete(id);timer.fn();await flush();assert.deepEqual(calls[1],['right',true]);
  hold.stop();settle(true);await flush();assert.equal(timers.size,0);
  hold.set('up'); await flush(); hold.set('left'); assert.equal(calls.length,3);
  settle(true);await flush();assert.deepEqual(calls[3],['left',false]);
  hold.stop();settle(true);await flush();assert.equal(timers.size,0);
  hold.set('down');hold.stop();await flush();assert.equal(calls.length,4,'released before dispatch sends nothing');
});
