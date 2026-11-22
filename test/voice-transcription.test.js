/**
 * Voice transcription (desktop app): WAV upload → OpenAI gpt-transcribe with the
 * user's key (simulated transport, no network) → text, with the usage and the
 * cost estimated from the audio duration.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateTranscriptionCost } from '../src/ai/pricing.js';
import { parseWav } from '../src/voice-transcription.js';
import { ANA_CONNECTION, signedIn, startApp } from './support/app-harness.js';
import { FAKE_KEY } from './support/fake-openai.js';

/** A 16 kHz mono 16-bit WAV of `seconds` (a quiet tone). */
function wav(seconds, { rate = 16_000, channels = 1 } = {}) {
  const frames = Math.round(seconds * rate);
  const data = Buffer.alloc(frames * channels * 2);
  for (let i = 0; i < frames * channels; i += 1) data.writeInt16LE(Math.round(Math.sin(i / 8) * 3000), i * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + data.length, 4); header.write('WAVE', 8); header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(channels, 22); header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * channels * 2, 28); header.writeUInt16LE(channels * 2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

async function upload(app, client, body, contentType = 'audio/wav') {
  const response = await fetch(`${app.base}/api/voice/transcribe`, {
    method: 'POST',
    headers: { 'content-type': contentType, cookie: [...client.jar].map(([name, cookie]) => `${name}=${cookie.value}`).join('; '), origin: app.base },
    body,
  });
  return { status: response.status, body: await response.json() };
}

test('WAV parsing and the per-second price', () => {
  assert.deepEqual(parseWav(wav(2.5)), { sampleRate: 16_000, channels: 1, durationMs: 2500 });
  assert.deepEqual(parseWav(wav(1, { rate: 48_000, channels: 2 })).durationMs, 1000);
  for (const bad of [Buffer.from('not audio'), Buffer.alloc(100), wav(1).subarray(0, 40)]) assert.throws(() => parseWav(bad), { code: 'INVALID_AUDIO' });
  // US$ 0.0045 per minute: 5 s = US$ 0.000375 = 375,000 nano-dollars.
  assert.deepEqual(estimateTranscriptionCost('gpt-transcribe', 5000, { at: Date.parse('2026-11-22') }), { costNanoUsd: 375_000, pricingVersion: 'transcription-2026-11-22' });
  assert.equal(estimateTranscriptionCost('whisper-1', 5000).reason, 'unknown-model');
});

test('transcribes with the user key, records usage and cost, and never echoes the key', async () => {
  const app = await startApp();
  const ana = await signedIn(app, 'ana', ANA_CONNECTION);
  assert.equal((await upload(app, app.client(), wav(1))).status, 401);
  const disabled = await upload(app, ana, wav(1));
  assert.deepEqual([disabled.status, disabled.body.code], [409, 'AI_DISABLED']);
  assert.equal(app.openai.requests.length, 0);

  await ana.put('/api/ai/settings', { enabled: true, apiKey: FAKE_KEY });
  app.openai.reply({ text: '  Gastei 40 reais no mercado,  categoria alimentação. ', usage: { type: 'tokens', input_tokens: 60, input_token_details: { audio_tokens: 60, text_tokens: 0 }, output_tokens: 14, total_tokens: 74 } }, { headers: { 'x-request-id': 'req_voice_1' } });
  const ok = await upload(app, ana, wav(4));
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body, { ok: true, text: 'Gastei 40 reais no mercado, categoria alimentação.', durationMs: 4000, costNanoUsd: 300_000 });
  const request = app.openai.requests[0];
  assert.equal(request.url, 'https://api.openai.com/v1/audio/transcriptions');
  assert.equal(request.headers.Authorization, `Bearer ${FAKE_KEY}`);
  assert.equal(request.body.get('model'), 'gpt-transcribe');
  assert.deepEqual(request.body.getAll('languages[]'), ['pt']);
  assert.equal(request.body.get('response_format'), 'json');
  assert.equal(request.body.get('file').type, 'audio/wav');
  assert.equal(JSON.stringify(ok.body).includes(FAKE_KEY), false);

  const row = app.db.prepare("SELECT * FROM ai_usage WHERE purpose = 'transcription'").get();
  assert.deepEqual([row.model, row.outcome, row.audio_ms, row.input_tokens, row.output_tokens, row.cost_nano_usd, row.response_id], ['gpt-transcribe', 'ok', 4000, 60, 14, 300_000, 'transcription:req_voice_1']);
  const usage = (await ana.get('/api/ai')).body.usage;
  assert.deepEqual(usage.transcription.currentMonth, { requests: 1, audioMs: 4000, costNanoUsd: 300_000 });
  assert.equal(usage.currentMonth.costNanoUsd, 300_000, 'included in the AI totals');
  await app.close();
});

test('bad uploads are refused before any OpenAI call; OpenAI errors are mapped and not billed', async () => {
  const app = await startApp();
  const ana = await signedIn(app, 'ana', ANA_CONNECTION);
  await ana.put('/api/ai/settings', { enabled: true, apiKey: FAKE_KEY });
  assert.equal((await upload(app, ana, wav(1), 'application/json')).status, 415);
  assert.deepEqual((await upload(app, ana, Buffer.from('RIFFxxxxWAVEnothing here at all, really not a wave file'))).body.code, 'INVALID_AUDIO');
  assert.equal((await upload(app, ana, Buffer.alloc(5 * 1024 * 1024))).status, 413);
  assert.equal((await upload(app, ana, wav(100))).status, 413, 'longer than the limit');
  assert.equal(app.openai.requests.length, 0);

  app.openai.replyError(401, { code: 'invalid_api_key' });
  const auth = await upload(app, ana, wav(1));
  assert.deepEqual([auth.status, auth.body.code], [502, 'AI_AUTH']);
  assert.equal(JSON.stringify(auth.body).includes('sk-test'), false, 'OpenAI messages (which quote the key) are not echoed');
  assert.equal(app.db.prepare("SELECT COUNT(*) FROM ai_usage WHERE purpose = 'transcription'").pluck().get(), 0);
  await app.close();
});
