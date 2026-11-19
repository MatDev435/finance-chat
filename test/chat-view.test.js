import test from 'node:test';
import assert from 'node:assert/strict';
import { announcementFor } from '../public/js/chat-view.js';

test('screen readers hear new assistant messages, with the preview headline', () => {
  assert.equal(announcementFor({ role: 'assistant', kind: 'text', text: 'Movimentação cancelada.' }), 'Movimentação cancelada.');
  assert.match(announcementFor({ role: 'assistant', kind: 'preview', text: 'Confira.', data: { type: 'expense', amount: 40 } }), /^Confira\. Despesa de R\$\s?40,00\.$/);
  assert.match(announcementFor({ role: 'assistant', kind: 'preview', text: 'Confira.', data: { type: 'income', amount: 10 } }), /Receita de R\$\s?10,00\.$/);
});

test('the user\'s own messages are not announced back', () => {
  assert.equal(announcementFor({ role: 'user', kind: 'text', text: 'Gastei 40' }), '');
  assert.equal(announcementFor(null), '');
});
