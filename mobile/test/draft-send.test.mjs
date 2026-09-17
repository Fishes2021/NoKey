import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';

// Execute the actual controller callback; substitute its network and UI state.
const source = await readFile(new URL('../app/index.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('index.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let callback;
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'sendDraft') callback = node.initializer.arguments[0].getText(ast);
  ts.forEachChild(node, visit);
}
visit(ast);
assert(callback);
const compiled = ts.transpileModule('globalThis.send = ' + callback, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

test('Mac input clears acknowledged draft, preserves sent whitespace and never invokes Codex', async () => {
  let calls = 0;
  const context = { inputDestination: 'mac', draft: ' 中文😀 ', draftSendInFlight: { current: false }, loadingAction: null,
    setDraft(update) { context.draft = update(context.draft); }, announce() {}, genericKeyboard: { press: async text => { assert.equal(text, ' 中文😀 '); calls++; return true; } } };
  vm.runInNewContext(compiled, context);
  await context.send();
  assert.equal(calls, 1);
  assert.equal(context.draft, '');
});

test('Mac input suppresses duplicate clicks and keeps failed drafts', async () => {
  let done, calls = 0;
  const context = { draft: '中文', draftSendInFlight: { current: false }, announce() {},
    genericKeyboard: { press: () => { calls++; return new Promise(resolve => { done = resolve; }); } } };
  vm.runInNewContext(compiled, context);
  const pending = context.send(); await context.send();
  assert.equal(calls, 1); done(false); await pending;
  assert.equal(context.draft, '中文'); assert.equal(context.draftSendInFlight.current, false);
  assert(!source.includes('/api/remote/send'));
  assert(!source.includes('Open Codex chat switcher'));
});


test('acknowledgement cannot erase edits made during transmission', async () => {
  let done;
  const context = { draft: '第一段', draftSendInFlight: { current: false }, announce() {},
    setDraft(update) { context.latestDraft = update(context.latestDraft); }, latestDraft: '新输入',
    genericKeyboard: { press: () => new Promise(resolve => { done = resolve; }) } };
  vm.runInNewContext(compiled, context);
  const pending = context.send(); done(true); await pending;
  assert.equal(context.latestDraft, '新输入');
});
