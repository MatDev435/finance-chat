/**
 * Voice transcription for the desktop app: the app records the microphone and the
 * quick window uploads a WAV here; the server sends it to OpenAI with the user's
 * own key (the same as the AI mode) and records the usage and its estimated cost.
 * The audio is never stored.
 */
import { HttpError } from './http.js';
import { estimateTranscriptionCost } from './ai/pricing.js';

export const TRANSCRIPTION_MODEL = 'gpt-transcribe';
/** 60 s of 16 kHz mono 16-bit audio is ~1.9 MB; a little more is accepted. */
export const MAX_AUDIO_BYTES = 4 * 1024 * 1024;
export const MAX_AUDIO_MS = 90_000;
/** Context for the model: domain and style only (no example sentences it could copy). */
export const TRANSCRIPTION_PROMPT = 'Mensagem curta de finanças pessoais em português do Brasil: despesas, receitas, categorias e valores em reais.';

const invalid = () => new HttpError(400, 'INVALID_AUDIO', 'Áudio inválido. Grave de novo.');

/** RIFF/WAVE, PCM 16-bit → { sampleRate, channels, durationMs }. Anything else is refused. */
export function parseWav(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') throw invalid();
  let offset = 12;
  let format = null;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ' && size >= 16 && body + 16 <= buffer.length) {
      format = { audioFormat: buffer.readUInt16LE(body), channels: buffer.readUInt16LE(body + 2), sampleRate: buffer.readUInt32LE(body + 4), bits: buffer.readUInt16LE(body + 14) };
    } else if (id === 'data') {
      if (!format || format.audioFormat !== 1 || format.bits !== 16 || format.channels < 1 || format.channels > 2 || format.sampleRate < 8000 || format.sampleRate > 48000) throw invalid();
      const bytes = Math.min(size, buffer.length - body);
      const durationMs = Math.round((bytes / (2 * format.channels) / format.sampleRate) * 1000);
      return { sampleRate: format.sampleRate, channels: format.channels, durationMs };
    }
    offset = body + size + (size % 2);
  }
  throw invalid();
}

/** Raw request body, up to `limit` bytes. */
export async function readAudio(request, limit = MAX_AUDIO_BYTES) {
  if (!/^audio\/(?:wav|x-wav|wave)\b/i.test(request.headers['content-type'] || '')) {
    throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Envie o áudio em WAV.');
  }
  if (Number(request.headers['content-length']) > limit) throw new HttpError(413, 'PAYLOAD_TOO_LARGE', 'Áudio longo demais (máximo de 60 segundos).');
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'PAYLOAD_TOO_LARGE', 'Áudio longo demais (máximo de 60 segundos).');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** Usage of a transcription in the shape the usage table expects (tokens when the API reports them). */
export function transcriptionUsage(usage) {
  if (!usage || usage.type !== 'tokens') return null;
  const count = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : 0);
  return {
    inputTokens: count(usage.input_tokens),
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: count(usage.output_tokens),
    reasoningTokens: 0,
    totalTokens: count(usage.total_tokens),
  };
}

export function createVoiceTranscription({ openai, aiStore, log = console, now = Date.now }) {
  return {
    async transcribe({ userId, credentials, audio }) {
      const { durationMs } = parseWav(audio);
      if (durationMs > MAX_AUDIO_MS) throw new HttpError(413, 'PAYLOAD_TOO_LARGE', 'Áudio longo demais (máximo de 60 segundos).');
      const cost = estimateTranscriptionCost(TRANSCRIPTION_MODEL, durationMs, { at: now() });
      let result;
      try {
        result = await openai.createTranscription({ apiKey: credentials.apiKey, audio, model: TRANSCRIPTION_MODEL, languages: ['pt'], prompt: TRANSCRIPTION_PROMPT });
      } catch (error) {
        // Billed by duration: a request that may have been processed is still recorded (cost of the audio sent).
        if (error.maybeProcessed) aiStore.recordUsage(userId, { purpose: 'transcription', model: TRANSCRIPTION_MODEL, outcome: error.code, usage: null, cost, audioMs: durationMs });
        throw error;
      }
      const usage = transcriptionUsage(result.usage);
      aiStore.recordUsage(userId, {
        purpose: 'transcription',
        model: TRANSCRIPTION_MODEL,
        outcome: 'ok',
        responseId: result.requestId ? `transcription:${result.requestId}` : null,
        // Usage rows need token counts to count as "known"; the cost comes from the duration either way.
        usage: usage ?? { inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0 },
        cost,
        audioMs: durationMs,
      });
      const text = result.text.replace(/\s+/g, ' ').trim();
      if (!text) log.warn?.('[openai] transcription returned no text');
      return { text, durationMs, costNanoUsd: cost.costNanoUsd };
    },
  };
}
