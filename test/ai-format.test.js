import test from 'node:test';
import assert from 'node:assert/strict';
import { formatTokens, formatUsd, modelHint, monthLabel, usageRows } from '../public/js/ai-format.js';

const usd = (nano) => formatUsd(nano).replace(/ /g, ' ');

test('costs never show US$ 0,00 once something was consumed', () => {
  assert.equal(usd(0), 'US$ 0,00');
  assert.equal(usd(24_800_000), 'US$ 0,0248');
  assert.equal(usd(250_000), 'US$ 0,00025');
  assert.equal(usd(1), 'US$ 0,000000001');
  assert.equal(usd(12_500_000_000), 'US$ 12,50');
});

test('usage rows show tokens, cache, reasoning, the estimate and what is outside it', () => {
  assert.deepEqual(usageRows({ requests: 0 }), [['Chamadas', 'nenhuma ainda']]);
  const rows = Object.fromEntries(usageRows({
    requests: 3, requestsWithoutUsage: 1, requestsWithoutCost: 1, inputTokens: 3010, cachedInputTokens: 400,
    outputTokens: 305, reasoningTokens: 30, totalTokens: 3315, costNanoUsd: 6_100_000,
  }).map(([label, value]) => [label, value.replace(/ /g, ' ')]));
  assert.equal(rows['Tokens de entrada'], '3.010 tokens (400 tokens em cache)');
  assert.equal(rows['Tokens de saída'], '305 tokens (30 tokens de raciocínio)');
  assert.equal(rows['Total de tokens'], '3.315 tokens');
  assert.equal(rows['Custo estimado'], 'US$ 0,0061');
  assert.match(rows['Observações'], /1 sem dados de uso.*1 sem preço conhecido/);
  assert.equal(formatTokens(1), '1 token');
});

test('model hints and month labels', () => {
  assert.equal(modelHint({ description: 'Econômico', prices: { input: '0.10', output: '0.50' } }), 'Econômico. Preço: US$ 0,10 por 1M tokens de entrada e US$ 0,50 por 1M de saída.');
  assert.equal(monthLabel('2026-11'), 'nov/2026');
  assert.equal(monthLabel(''), '');
});

test('voice transcription usage line', async () => {
  const { transcriptionText } = await import('../public/js/ai-format.js');
  assert.equal(transcriptionText({ requests: 0 }), 'nenhuma ainda');
  assert.equal(transcriptionText({ requests: 3, audioMs: 42_400, costNanoUsd: 3_180_000 }).replace(/ /g, ' '), '3 áudios · 0:42 · US$ 0,00318');
  assert.match(transcriptionText({ requests: 1, audioMs: 65_000, costNanoUsd: 4_875_000 }), /^1 áudio · 1:05 · /);
});
