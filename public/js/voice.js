/**
 * Voice dictation for the composer (Web Speech API, SpeechRecognition).
 * The recognized text only fills the message field: nothing is ever sent
 * automatically, so the user always reviews it before the usual preview and
 * confirmation. Browsers without the API (e.g. Firefox) simply do not show
 * the microphone button. Speech is processed by the browser's own service
 * (Google for Chrome/Android, Apple for Safari/iOS), never by this server.
 */

/** The SpeechRecognition constructor of this browser, or null. */
export function speechRecognitionClass(win = globalThis) {
  return win?.SpeechRecognition || win?.webkitSpeechRecognition || null;
}

/** Text already typed + what is being dictated, with a single space between them. */
export function mergeTranscript(base, transcript) {
  const spoken = String(transcript || '').replace(/\s+/g, ' ').trim();
  const typed = String(base || '').replace(/\s+$/, '');
  if (!spoken) return typed;
  return typed ? `${typed} ${spoken}` : spoken.charAt(0).toLocaleUpperCase('pt-BR') + spoken.slice(1);
}

const ERROR_MESSAGES = {
  'not-allowed': 'O microfone não foi liberado. Permita o acesso ao microfone para este site nas configurações do navegador.',
  'service-not-allowed': 'O navegador não permitiu o reconhecimento de voz. Verifique as permissões de microfone e de voz.',
  'audio-capture': 'Nenhum microfone foi encontrado.',
  'no-speech': 'Não ouvi nada. Toque no microfone e tente de novo.',
  network: 'O reconhecimento de voz do navegador precisa de internet.',
  'language-not-supported': 'O navegador não reconhece fala em português neste aparelho.',
  insecure: 'O ditado por voz só funciona com o Finance Chat aberto em HTTPS (ou em localhost).',
};

/** User-facing text for a SpeechRecognition error code (null for an intentional stop). */
export function voiceErrorMessage(code) {
  if (code === 'aborted') return null;
  return ERROR_MESSAGES[code] || 'Não foi possível usar o ditado por voz agora.';
}

/**
 * Wires the microphone button. `status` is a visible role="status" line;
 * `announce(text)` speaks short messages through the chat's live region.
 * Returns { stop(), get listening }.
 */
export function createVoiceInput({ button, input, status, announce = () => {}, win = globalThis }) {
  const Recognition = speechRecognitionClass(win);
  if (!Recognition) {
    button.hidden = true;
    return { stop() {}, get listening() { return false; } };
  }
  button.hidden = false;
  let recognition = null;
  let base = '';
  let finalText = '';
  let failed = false;
  let cancelled = false;

  function setStatus(text, error = false) {
    status.textContent = text || '';
    status.hidden = !text;
    status.classList.toggle('is-error', Boolean(text) && error);
  }

  function setListening(on) {
    button.setAttribute('aria-pressed', String(on));
    button.setAttribute('aria-label', on ? 'Parar o ditado' : 'Ditar mensagem por voz');
    button.title = on ? 'Parar o ditado' : 'Ditar mensagem por voz';
    button.classList.toggle('is-listening', on);
  }

  function start() {
    if (!win.isSecureContext) {
      setStatus(voiceErrorMessage('insecure'), true);
      return;
    }
    recognition = new Recognition();
    recognition.lang = 'pt-BR';
    recognition.interimResults = true;
    recognition.continuous = false; // one phrase per tap: the most reliable mode on phones
    recognition.maxAlternatives = 1;
    base = input.value;
    finalText = '';
    failed = false;
    cancelled = false;

    recognition.onresult = (event) => {
      let interim = '';
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        if (result.isFinal) finalText += ` ${result[0].transcript}`;
        else interim += ` ${result[0].transcript}`;
      }
      input.value = mergeTranscript(base, `${finalText} ${interim}`).slice(0, input.maxLength > 0 ? input.maxLength : undefined);
    };
    recognition.onerror = (event) => {
      const message = voiceErrorMessage(event.error);
      if (!message) return;
      failed = true;
      setStatus(message, true);
      announce(message);
    };
    recognition.onend = () => {
      recognition = null;
      setListening(false);
      if (failed || cancelled) return;
      const heard = finalText.trim();
      setStatus(heard ? 'Pronto. Revise o texto e envie quando quiser.' : '');
      if (heard) announce('Texto ditado no campo de mensagem. Revise e envie quando quiser.');
      input.focus({ preventScroll: true });
      const end = input.value.length;
      input.setSelectionRange?.(end, end);
    };

    try {
      recognition.start();
    } catch {
      recognition = null;
      setStatus(voiceErrorMessage('unknown'), true);
      return;
    }
    setListening(true);
    setStatus('Ouvindo... fale a sua mensagem.');
    announce('Ouvindo. Fale a sua mensagem.');
  }

  function stop() {
    recognition?.stop();
  }

  button.addEventListener('click', () => {
    if (recognition) stop();
    else start();
  });
  // Typing while dictating takes over: dictation stops and keeps what was heard.
  input.addEventListener('keydown', () => { if (recognition) stop(); });

  return {
    /** Cancels dictation silently (message sent, chat changed); the text already in the field stays. */
    stop() {
      if (recognition) {
        cancelled = true;
        recognition.abort();
      }
      setStatus('');
    },
    get listening() { return Boolean(recognition); },
  };
}
