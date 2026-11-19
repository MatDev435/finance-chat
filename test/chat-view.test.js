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

test('batch announcements and search periods', async () => {
  const { searchPeriod } = await import('../public/js/chat-view.js');
  assert.equal(announcementFor({ role: 'assistant', kind: 'batch', text: 'Confira.', data: { items: [{}, {}, {}] } }), 'Confira. 3 movimentações aguardando aprovação.');
  assert.equal(searchPeriod({ from: null, to: '2026-11-19' }), 'Todo o histórico');
  assert.equal(searchPeriod({ from: '2026-10-01', to: '2026-10-31' }), '01/10/2026 a 31/10/2026');
  assert.equal(searchPeriod({ from: '2026-11-19', to: '2026-11-19' }), '19/11/2026');
});
