import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createKeyPreferences } from '../lib/key-preferences.mjs';
test('Mac layout survives restart and new pairing; stale, malformed and corrupt writes cannot overwrite it', async () => {
 const dir=await mkdtemp('build/key-preferences-');
 try {
  const store=await createKeyPreferences(dir), first=store.read();
  assert.equal(first.keys,null);
  const keys=Array(10).fill(null);keys[6]={keycapId:'NAV',label:'上',action:{type:'shortcut',key:'ArrowUp',modifiers:[]}};
  const saved=await store.save({revision:0,keys});assert.equal(saved.revision,1);
  const restarted=await createKeyPreferences(dir);
  assert.deepEqual(restarted.read(),saved);assert.equal(restarted.read().macId,first.macId);
  await assert.rejects(restarted.save({revision:0,keys}),/已变化/);
  await assert.rejects(restarted.save({revision:1,keys:[]}),/10/);
  keys[6].action.key='shell-command';await assert.rejects(restarted.save({revision:1,keys}));
  assert.deepEqual(restarted.read(),saved);
  const disk=await readFile(dir+'/keyboard-layout.json','utf8');assert.equal(JSON.parse(disk).revision,1);
  await writeFile(dir+'/keyboard-layout.json','broken');
  const damaged=await createKeyPreferences(dir);assert.throws(()=>damaged.read(),/损坏/);
  await assert.rejects(damaged.save({revision:0,keys:[]}),/损坏/);
  assert.equal(await readFile(dir+'/keyboard-layout.json','utf8'),'broken');
 } finally { await rm(dir,{recursive:true,force:true}); }
});
