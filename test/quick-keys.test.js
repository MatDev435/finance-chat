import test from 'node:test';
import assert from 'node:assert/strict';
import { APPROVE_GUARD_MS, canApprove, modifierLabel, quickKeyAction } from '../public/js/quick-keys.js';
import { shortcutLabel } from '../public/js/desktop-bridge.js';

test('quick window keys: Esc hides, Ctrl/⌘+Enter approves, Ctrl+1..3 picks; plain Enter is never an approval', () => {
  assert.deepEqual(quickKeyAction({ key: 'Escape' }), { type: 'hide' });
  assert.deepEqual(quickKeyAction({ key: 'Enter', ctrlKey: true }), { type: 'approve' });
  assert.deepEqual(quickKeyAction({ key: 'Enter', metaKey: true }), { type: 'approve' });
  assert.equal(quickKeyAction({ key: 'Enter' }), null);
  assert.deepEqual(quickKeyAction({ key: '2', code: 'Digit2', ctrlKey: true }), { type: 'pick', index: 1 });
  assert.deepEqual(quickKeyAction({ key: '!', code: 'Digit1', ctrlKey: true }), { type: 'pick', index: 0 }, 'layouts where Ctrl+1 is not "1"');
  assert.equal(quickKeyAction({ key: '4', code: 'Digit4', ctrlKey: true }), null);
  assert.equal(quickKeyAction({ key: '1', code: 'Digit1' }), null, 'typing a digit stays typing');
  assert.equal(quickKeyAction({ key: 'Enter', ctrlKey: true, isComposing: true }), null);
});

test('approval guard, modifier label and shortcut label', () => {
  assert.equal(canApprove(1000, 1000 + APPROVE_GUARD_MS - 1), false);
  assert.equal(canApprove(1000, 1000 + APPROVE_GUARD_MS), true);
  assert.equal(modifierLabel('MacIntel'), '⌘');
  assert.equal(modifierLabel('Win32'), 'Ctrl');
  assert.equal(shortcutLabel('Alt+Space'), 'Alt+Espaço');
  assert.equal(shortcutLabel('CommandOrControl+Shift+Space'), 'Ctrl+Shift+Espaço');
});
