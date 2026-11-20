/**
 * Voice dictation with a simulated SpeechRecognition and minimal elements:
 * the recognized text only fills the field (nothing is sent), in pt-BR,
 * with clear messages for the browser's errors.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createVoiceInput, mergeTranscript, speechRecognitionClass, voiceErrorMessage } from '../public/js/voice.js';
import { applySecurityHeaders } from '../src/http.js';

function fakeElement(extra = {}) {
  const listeners = {};
  const attributes = {};
  const classes = new Set();
  return {
    hidden: true, title: '', textContent: '', value: '', maxLength: 500, focused: false,
    addEventListener: (type, handler) => { listeners[type] = handler; },
    fire: (type, event = {}) => listeners[type]?.(event),
    setAttribute: (name, value) => { attributes[name] = value; },
    getAttribute: (name) => attributes[name],
    classList: { toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)), contains: (name) => classes.has(name) },
    focus() { this.focused = true; },
    setSelectionRange() {},
    ...extra,
  };
}

function setup({ secure = true, supported = true } = {}) {
  const instances = [];
  class FakeRecognition {
    constructor() { instances.push(this); this.started = false; this.aborted = false; }
    start() { this.started = true; }
    stop() { this.onend?.(); }
    abort() { this.aborted = true; this.onerror?.({ error: 'aborted' }); this.onend?.(); }
  }
  const win = { isSecureContext: secure, ...(supported ? { webkitSpeechRecognition: FakeRecognition } : {}) };
  const button = fakeElement();
  const input = fakeElement();
  const status = fakeElement();
  const spoken = [];
  const voice = createVoiceInput({ button, input, status, announce: (text) => spoken.push(text), win });
  const result = (transcript, isFinal) => {
    const list = [Object.assign([{ transcript }], { isFinal })];
    return { resultIndex: 0, results: list };
  };
  return { voice, button, input, status, spoken, instances, result };
}

test('no Web Speech API (e.g. Firefox): the microphone button stays hidden', () => {
  const { button, voice } = setup({ supported: false });
  assert.equal(button.hidden, true);
  assert.equal(voice.listening, false);
  assert.equal(speechRecognitionClass({ SpeechRecognition: 'A', webkitSpeechRecognition: 'B' }), 'A');
});

test('dictation fills the field in pt-BR, keeps what was typed, and never sends anything', () => {
  const { button, input, status, spoken, instances, result } = setup();
  assert.equal(button.hidden, false);
  input.value = 'Gastei 40';
  button.fire('click');
  const [recognition] = instances;
  assert.deepEqual([recognition.lang, recognition.interimResults, recognition.started], ['pt-BR', true, true]);
  assert.equal(button.getAttribute('aria-pressed'), 'true');
  assert.equal(button.getAttribute('aria-label'), 'Parar o ditado');
  assert.match(status.textContent, /Ouvindo/);
  recognition.onresult(result('reais no mercado', false));
  assert.equal(input.value, 'Gastei 40 reais no mercado');
  recognition.onresult(result('reais no mercado categoria alimentação', true));
  recognition.onend();
  assert.equal(input.value, 'Gastei 40 reais no mercado categoria alimentação');
  assert.equal(button.getAttribute('aria-pressed'), 'false');
  assert.equal(input.focused, true);
  assert.match(status.textContent, /Revise o texto e envie/);
  assert.match(spoken.at(-1), /Revise e envie/);
});

test('browser errors become clear messages; cancelling (message sent) is silent', () => {
  const denied = setup();
  denied.button.fire('click');
  denied.instances[0].onerror({ error: 'not-allowed' });
  denied.instances[0].onend();
  assert.match(denied.status.textContent, /microfone não foi liberado/);
  assert.equal(denied.status.classList.contains('is-error'), true);

  const cancelled = setup();
  cancelled.button.fire('click');
  cancelled.instances[0].onresult(cancelled.result('gastei dez', false));
  cancelled.voice.stop();
  assert.equal(cancelled.instances[0].aborted, true);
  assert.equal(cancelled.status.textContent, '');
  assert.equal(cancelled.input.value, 'Gastei dez', 'what was heard stays in the field');

  const insecure = setup({ secure: false });
  insecure.button.fire('click');
  assert.equal(insecure.instances.length, 0);
  assert.match(insecure.status.textContent, /HTTPS/);
  assert.equal(voiceErrorMessage('aborted'), null);
  assert.match(voiceErrorMessage('whatever'), /Não foi possível/);
});

test('transcripts are merged with a single space; the microphone is allowed for this site only', () => {
  assert.equal(mergeTranscript('', ' gastei  dez reais '), 'Gastei dez reais');
  assert.equal(mergeTranscript('Gastei 10 ', 'no mercado'), 'Gastei 10 no mercado');
  assert.equal(mergeTranscript('Gastei 10', ''), 'Gastei 10');
  const headers = {};
  applySecurityHeaders({ setHeader: (name, value) => { headers[name] = value; } });
  assert.match(headers['Permissions-Policy'], /microphone=\(self\)/);
  assert.match(headers['Permissions-Policy'], /camera=\(\)/);
});
