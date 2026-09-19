import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MICRO_KEYCAP_IDS,
  PROGRAMMABLE_COMMAND_IDS,
  defaultProgrammedKeys,
  legacyActionIdForProgrammedKey,
  parseProgrammedKeys,
  programmedActionId,
} from '../lib/programmed-keys.ts';
import {
  OFFICIAL_CODEX_MICRO_GLYPHS,
  OFFICIAL_CODEX_MICRO_KEYCAP_LEGENDS,
} from '../lib/official-codex-micro-glyphs.ts';

test('the official Codex Micro artwork covers every physical keycap', () => {
  assert.deepEqual(
    Object.keys(OFFICIAL_CODEX_MICRO_KEYCAP_LEGENDS).sort(),
    [...MICRO_KEYCAP_IDS].sort(),
  );

  for (const [keycapId, legend] of Object.entries(
    OFFICIAL_CODEX_MICRO_KEYCAP_LEGENDS,
  )) {
    if (['empty', 'yolo', 'yeet'].includes(legend)) continue;
    assert.ok(
      OFFICIAL_CODEX_MICRO_GLYPHS[legend],
      `${keycapId} points at missing official artwork ${legend}`,
    );
  }
});

test('the six default controls use their official legends', () => {
  assert.deepEqual(
    Object.fromEntries(
      ['FAST', 'APPR', 'REJ', 'SPLIT', 'MIC', 'CODEX'].map((keycapId) => [
        keycapId,
        OFFICIAL_CODEX_MICRO_KEYCAP_LEGENDS[keycapId],
      ]),
    ),
    {
      FAST: 'lightning-outline',
      APPR: 'check-circle',
      REJ: 'x-circle',
      SPLIT: 'worktree',
      MIC: 'mic',
      CODEX: 'codex',
    },
  );
});

test('printed Codex Micro keycaps stay separate from command ids', () => {
  assert.equal(MICRO_KEYCAP_IDS.length, 38);
  assert.equal(new Set(MICRO_KEYCAP_IDS).size, MICRO_KEYCAP_IDS.length);
  for (const keycapId of [
    'BUG', 'GIT', 'PR', 'YOLO', 'YEET', 'BRANCH', 'EMPT5',
  ]) {
    assert.ok(MICRO_KEYCAP_IDS.includes(keycapId));
    assert.equal(PROGRAMMABLE_COMMAND_IDS.includes(keycapId), false);
  }
});

test('every official non-blank keycap has a default action', async () => {
  const { defaultActionForKeycap, DEFAULT_KEYCAP_PROMPTS } = await import(
    '../lib/programmed-keys.ts'
  );
  for (const keycapId of MICRO_KEYCAP_IDS) {
    if (keycapId.startsWith('EMPT')) {
      assert.equal(defaultActionForKeycap(keycapId), null);
      continue;
    }
    const action = defaultActionForKeycap(keycapId);
    assert.ok(action, `${keycapId} needs an official default`);
    if (keycapId === 'YOLO' || keycapId === 'YEET') {
      assert.equal(action.type, 'prompt');
      assert.equal(action.text, DEFAULT_KEYCAP_PROMPTS[keycapId]);
    } else {
      assert.equal(action.type, 'command');
      assert.ok(PROGRAMMABLE_COMMAND_IDS.includes(action.commandId));
    }
  }
});

test('a keycap and its assigned Codex command round-trip independently', () => {
  const keys = parseProgrammedKeys(JSON.stringify([
    {
      keycapId: 'GIT',
      action: {
        type: 'command',
        commandId: 'composer.toggleFastMode',
      },
    },
    null,
    null,
    null,
    null,
    null,
  ]));
  assert.deepEqual(keys[0], {
    keycapId: 'GIT',
    action: {
      type: 'command',
      commandId: 'composer.toggleFastMode',
    },
  });
  assert.equal(programmedActionId(keys[0]), 'composer.toggleFastMode');
  assert.equal(legacyActionIdForProgrammedKey(keys[0]), 'FAST');
});

test('verified legacy assignments migrate to real command ids', () => {
  const keys = parseProgrammedKeys(JSON.stringify([
    { actionId: 'FAST' },
    { actionId: 'PLAN' },
    { actionId: 'MIND+' },
    { actionId: 'EMPT4', customText: 'Run all tests' },
    null,
    null,
  ]));
  assert.equal(programmedActionId(keys[0]), 'composer.toggleFastMode');
  assert.equal(programmedActionId(keys[1]), 'composer.togglePlanMode');
  assert.equal(
    programmedActionId(keys[2]),
    'composer.increaseReasoningEffort',
  );
  assert.deepEqual(keys[3], {
    keycapId: 'EMPT4',
    action: {
      type: 'prompt',
      text: 'Run all tests',
    },
  });
  assert.equal(legacyActionIdForProgrammedKey(keys[3]), 'EMPT1');
});

test('fake legacy keycap behavior is removed without discarding the cap', () => {
  const keys = parseProgrammedKeys(JSON.stringify([
    { actionId: 'GIT' },
    { actionId: 'PR' },
    { actionId: 'YOLO' },
    null,
    null,
    null,
  ]));
  assert.deepEqual(keys.slice(0, 3), [
    { keycapId: 'GIT', action: null },
    { keycapId: 'PR', action: null },
    { keycapId: 'YOLO', action: null },
  ]);
});

test('malformed storage falls back to the official default layout', () => {
  assert.deepEqual(parseProgrammedKeys('not json'), defaultProgrammedKeys());
  assert.deepEqual(
    parseProgrammedKeys(JSON.stringify([null])),
    defaultProgrammedKeys(),
  );
});


test('generic shortcuts preserve names and never fall back to unrelated Codex commands', () => {
  const stored = [
    { keycapId: 'APPR', label: '粘贴', action: { type: 'shortcut', key: 'V', modifiers: ['shift', 'command'] } },
    { keycapId: 'APPR', action: { type: 'shortcut', key: 'shell', modifiers: [] } },
    { keycapId: 'APPR', action: null },
    { keycapId: 'APPR', action: { type: 'shortcut', key: 'V', modifiers: ['command', 'command'] } },
    { keycapId: 'MIC' }, null,
  ];
  const keys = parseProgrammedKeys(JSON.stringify(stored));
  assert.deepEqual(keys[0], { keycapId: 'APPR', label: '粘贴', action: { type: 'shortcut', key: 'V', modifiers: ['command', 'shift'] } });
  assert.equal(programmedActionId(keys[0]), 'voicedeck.shortcut');
  assert.equal(legacyActionIdForProgrammedKey(keys[0]), null);
  for (const index of [1, 2, 3]) assert.equal(keys[index].action, null);
  assert.equal(programmedActionId(keys[4]), 'composer.startDictation');
  assert.deepEqual(parseProgrammedKeys(JSON.stringify(keys)), keys);
});

test('generic controller migrates AI commands but preserves user shortcuts and empty slots', async () => {
  const { parseGenericProgrammedKeys } = await import('../lib/programmed-keys.ts');
  const custom = { keycapId: 'MIC', label: '自定义', action: { type: 'shortcut', key: 'V', modifiers: ['command'] } };
  const migrated = parseGenericProgrammedKeys(JSON.stringify([
    { keycapId: 'MIC', action: { type: 'command', commandId: 'composer.startDictation' } },
    custom, null, { keycapId: 'APPR', action: null },
    { actionId: 'FAST' }, { actionId: 'EMPT5', customText: 'legacy AI prompt' },
  ]));
  assert.equal(migrated[0].action.type, 'shortcut');
  assert.deepEqual(migrated[1], custom);
  assert.equal(migrated[2], null); assert.equal(migrated[3].action, null);
  assert(migrated.filter(Boolean).every(key => !key.action || key.action.type === 'shortcut'));
  assert(defaultProgrammedKeys().filter(Boolean).every(key => key.action.type === 'shortcut'));
});

test('NoKey replaces only the two unchanged navigation defaults', async () => {
  const { parseGenericProgrammedKeys } = await import('../lib/programmed-keys.ts');
  const old = defaultProgrammedKeys();
  old[4] = { ...old[4], label: '行首', action: { type: 'shortcut', key: 'Home', modifiers: [] } };
  old[5] = { ...old[5], label: '行尾', action: { type: 'shortcut', key: 'End', modifiers: [] } };
  const next = parseGenericProgrammedKeys(JSON.stringify(old));
  assert.deepEqual(next[4].action, { type: 'shortcut', key: 'Enter', modifiers: ['shift'] });
  assert.deepEqual(next[5].action, { type: 'shortcut', key: 'Z', modifiers: ['command', 'shift'] });
  old[4].label = '我的行首';
  assert.deepEqual(parseGenericProgrammedKeys(JSON.stringify(old))[4], old[4]);
});


test('joystick slots migrate six-key layouts without changing user keys and persist independently', async () => {
  const { parseGenericProgrammedKeys } = await import('../lib/programmed-keys.ts');
  const old = defaultProgrammedKeys().slice(0, 6);
  const next = parseGenericProgrammedKeys(JSON.stringify(old));
  assert.deepEqual(next.slice(0, 6), old);
  assert.deepEqual(next.slice(6).map(key => key.action.key), ['ArrowUp', 'ArrowRight', 'ArrowDown', 'ArrowLeft']);
  next[7] = { keycapId: 'EMPT5', label: '搜索', action: { type: 'shortcut', key: 'F', modifiers: ['command'] } };
  assert.deepEqual(parseGenericProgrammedKeys(JSON.stringify(next)), next);
  next[7].action.key = 'invalid';
  assert.equal(parseGenericProgrammedKeys(JSON.stringify(next))[7].action, null);
});
