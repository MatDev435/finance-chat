//! Voice capture and local transcription (push to talk).
//!
//! Holding the global shortcut (or clicking the microphone in the quick window)
//! starts a capture thread that owns the microphone stream; releasing it (or
//! clicking again) stops the capture, and the same thread transcribes the audio
//! with Whisper on this computer. The quick window follows every step through
//! "voice://state" events (recording, transcribing, done, error, model-missing),
//! which it shows and announces to screen readers; sound cues mark the start
//! and the end of the recording. The text only fills the message field: nothing
//! is sent without the user.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, Sample, SampleFormat, SizedSample, StreamConfig};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::sound::{self, Cue};
use crate::{audio, model, windows, AppState};

pub use crate::model::ModelInfo;

/// Whether this build includes local speech recognition (the "whisper" feature).
pub const AVAILABLE: bool = cfg!(feature = "whisper");
/// A recording stops by itself after this long.
const MAX_RECORDING: Duration = Duration::from_secs(60);
/// Shorter recordings are treated as "nothing said".
const MIN_SPEECH_SECONDS: f32 = 0.35;
/// Below this loudness (RMS) the recording is treated as silence (Whisper invents text in silence).
const SILENCE_RMS: f32 = 0.003;

#[derive(Default)]
pub struct Voice {
    stop: Mutex<Option<Sender<()>>>,
    busy: AtomicBool,
}

impl Voice {
    /// Recording or transcribing.
    pub fn busy(&self) -> bool {
        self.busy.load(Ordering::SeqCst)
    }

    pub fn recording(&self) -> bool {
        self.stop.lock().map(|stop| stop.is_some()).unwrap_or(false)
    }

    fn request_stop(&self) {
        if let Some(stop) = self.stop.lock().ok().and_then(|mut stop| stop.take()) {
            let _ = stop.send(());
        }
    }
}

pub fn models(app: &AppHandle) -> Vec<ModelInfo> {
    model::list(app)
}

/// The selected model is downloaded (and this build has Whisper).
pub fn ready(app: &AppHandle) -> bool {
    AVAILABLE && model::exists(app, &current_model(app))
}

fn current_model(app: &AppHandle) -> String {
    app.state::<AppState>().settings.lock().map(|settings| settings.voice_model.clone()).unwrap_or_default()
}

fn sounds_enabled(app: &AppHandle) -> bool {
    app.state::<AppState>().settings.lock().map(|settings| settings.sounds).unwrap_or(true)
}

fn emit(app: &AppHandle, payload: Value) {
    let _ = app.emit_to(windows::QUICK, "voice://state", payload);
}

fn fail(app: &AppHandle, message: &str) {
    if sounds_enabled(app) {
        sound::play(Cue::Error);
    }
    emit(app, json!({ "state": "error", "message": message }));
}

/// Shortcut held: show the quick window in voice mode and start listening.
pub fn hold_start(app: &AppHandle) {
    windows::show_quick(app, "voice");
    start(app);
}

/// Shortcut released: stop listening and transcribe.
pub fn hold_end(app: &AppHandle) {
    app.state::<AppState>().voice.request_stop();
}

/// Microphone button of the quick window: start, or stop and transcribe.
pub fn toggle(app: &AppHandle) {
    let voice = &app.state::<AppState>().voice;
    if voice.recording() {
        voice.request_stop();
    } else {
        start(app);
    }
}

/// The quick page finished loading: tell it about a capture already in progress.
pub fn resend_state(app: &AppHandle) {
    let voice = &app.state::<AppState>().voice;
    if voice.recording() {
        emit(app, json!({ "state": "recording" }));
    } else if voice.busy() {
        emit(app, json!({ "state": "transcribing" }));
    }
}

fn start(app: &AppHandle) {
    let state = app.state::<AppState>();
    if !AVAILABLE {
        fail(app, "Esta versão do app foi gerada sem reconhecimento de voz.");
        return;
    }
    let name = current_model(app);
    let Some(model_path) = model::path(app, &name).filter(|_| model::exists(app, &name)) else {
        if sounds_enabled(app) {
            sound::play(Cue::Error);
        }
        emit(app, json!({ "state": "model-missing" }));
        return;
    };
    if state.voice.busy.swap(true, Ordering::SeqCst) {
        return; // already recording or transcribing
    }
    let (stop_sender, stop_receiver) = mpsc::channel();
    if let Ok(mut stop) = state.voice.stop.lock() {
        *stop = Some(stop_sender);
    }
    let app = app.clone();
    thread::spawn(move || {
        let sounds = sounds_enabled(&app);
        let captured = capture(&app, stop_receiver, sounds);
        if let Ok(mut stop) = app.state::<AppState>().voice.stop.lock() {
            stop.take();
        }
        match captured {
            Err(message) => fail(&app, &message),
            Ok((mono, rate)) => {
                emit(&app, json!({ "state": "transcribing" }));
                let samples = audio::trim_silence(&audio::resample(&mono, rate, audio::WHISPER_RATE), audio::WHISPER_RATE);
                let too_short = (samples.len() as f32) < audio::WHISPER_RATE as f32 * MIN_SPEECH_SECONDS;
                if too_short || audio::rms(&samples) < SILENCE_RMS {
                    emit(&app, json!({ "state": "done", "text": "" }));
                } else {
                    match transcribe(&model_path, &samples) {
                        Ok(text) => emit(&app, json!({ "state": "done", "text": text })),
                        Err(message) => fail(&app, &message),
                    }
                }
            }
        }
        app.state::<AppState>().voice.busy.store(false, Ordering::SeqCst);
    });
}

/// Records from the default microphone until stopped (or [`MAX_RECORDING`]).
/// Returns mono samples and their sample rate. The stream lives in this thread only.
fn capture(app: &AppHandle, stop: mpsc::Receiver<()>, sounds: bool) -> Result<(Vec<f32>, u32), String> {
    let device = cpal::default_host().default_input_device().ok_or("Nenhum microfone foi encontrado.")?;
    let supported = device.default_input_config().map_err(|_| "Não foi possível usar o microfone.".to_string())?;
    let format = supported.sample_format();
    let config: StreamConfig = supported.into();
    let rate = config.sample_rate;
    let channels = usize::from(config.channels);
    let buffer = Arc::new(Mutex::new(Vec::<f32>::with_capacity(rate as usize * channels * 10)));
    let stream = match format {
        SampleFormat::F32 => input_stream::<f32>(&device, config, buffer.clone()),
        SampleFormat::I16 => input_stream::<i16>(&device, config, buffer.clone()),
        SampleFormat::U16 => input_stream::<u16>(&device, config, buffer.clone()),
        SampleFormat::I32 => input_stream::<i32>(&device, config, buffer.clone()),
        _ => Err("Formato de áudio do microfone não suportado.".into()),
    }?;
    stream
        .play()
        .map_err(|_| "Não foi possível iniciar o microfone. Verifique se o app tem permissão para usá-lo.".to_string())?;

    // The cue says "listening now"; the audio captured while it plays is dropped below.
    if sounds {
        sound::play(Cue::Start);
    }
    emit(app, json!({ "state": "recording" }));
    let _ = stop.recv_timeout(MAX_RECORDING);
    drop(stream);
    if sounds {
        sound::play(Cue::Stop);
    }

    let interleaved = std::mem::take(&mut *buffer.lock().map_err(|_| "Falha ao ler o áudio.".to_string())?);
    let mut mono = audio::to_mono(&interleaved, channels);
    if sounds {
        // Exactly the cue: it means "speak now", and cutting into the first word makes Whisper guess it.
        let skip = ((rate as f32) * Cue::Start.duration().as_secs_f32()) as usize;
        mono.drain(..skip.min(mono.len()));
    }
    Ok((mono, rate))
}

fn input_stream<T>(device: &cpal::Device, config: StreamConfig, buffer: Arc<Mutex<Vec<f32>>>) -> Result<cpal::Stream, String>
where
    T: SizedSample + Sample,
    f32: FromSample<T>,
{
    device
        .build_input_stream(
            config,
            move |data: &[T], _: &cpal::InputCallbackInfo| {
                if let Ok(mut buffer) = buffer.lock() {
                    buffer.extend(data.iter().map(|sample| f32::from_sample(*sample)));
                }
            },
            |_| {},
            None,
        )
        .map_err(|_| "Não foi possível abrir o microfone.".to_string())
}

#[cfg(feature = "whisper")]
fn transcribe(model_path: &std::path::Path, samples: &[f32]) -> Result<String, String> {
    use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

    // The model stays loaded between uses (loading it takes a moment); a different model replaces it.
    static CONTEXT: Mutex<Option<(std::path::PathBuf, WhisperContext)>> = Mutex::new(None);
    let mut slot = CONTEXT.lock().map_err(|_| "Falha interna na transcrição.".to_string())?;
    if slot.as_ref().map(|(path, _)| path != model_path).unwrap_or(true) {
        let path = model_path.to_str().ok_or("Caminho do modelo inválido.")?;
        let context = WhisperContext::new_with_params(path, WhisperContextParameters::default())
            .map_err(|_| "Não foi possível carregar o modelo de voz. Baixe-o de novo nas configurações do app.".to_string())?;
        *slot = Some((model_path.to_path_buf(), context));
    }
    let (_, context) = slot.as_ref().ok_or("Modelo indisponível.")?;
    let mut state = context.create_state().map_err(|_| "Falha ao preparar a transcrição.".to_string())?;

    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    params.set_language(Some("pt"));
    params.set_translate(false);
    let threads = thread::available_parallelism().map(|count| count.get()).unwrap_or(4).clamp(1, 8);
    params.set_n_threads(threads as i32);
    params.set_no_context(true);
    params.set_suppress_blank(true);
    params.set_print_special(false);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);
    // Nudges the style (Brazilian Portuguese, amounts as digits) without example sentences:
    // Whisper copies the content of a prompt that reads like a previous transcript.
    let prompt = format!("{}.", audio::PROMPT_WORDS.join(", "));
    params.set_initial_prompt(&prompt);

    state.full(params, samples).map_err(|_| "Não foi possível transcrever o áudio.".to_string())?;
    let mut text = String::new();
    for segment in state.as_iter() {
        if let Ok(part) = segment.to_str_lossy() {
            text.push_str(&part);
            text.push(' ');
        }
    }
    Ok(audio::strip_prompt_echo(&audio::clean_transcript(&text)))
}

#[cfg(not(feature = "whisper"))]
fn transcribe(_model_path: &std::path::Path, _samples: &[f32]) -> Result<String, String> {
    Err("Esta versão do app foi gerada sem reconhecimento de voz.".into())
}

#[cfg(all(test, feature = "whisper"))]
mod tests {
    use super::*;

    /// 16-bit PCM WAV → (sample rate, channels, interleaved samples).
    fn read_wav(bytes: &[u8]) -> (u32, usize, Vec<f32>) {
        let u16_at = |offset: usize| u16::from_le_bytes([bytes[offset], bytes[offset + 1]]);
        let u32_at = |offset: usize| u32::from_le_bytes([bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]]);
        assert_eq!(&bytes[0..4], b"RIFF");
        let (mut rate, mut channels, mut offset) = (0, 0, 12);
        while offset + 8 <= bytes.len() {
            let size = u32_at(offset + 4) as usize;
            let body = offset + 8;
            match &bytes[offset..offset + 4] {
                b"fmt " => {
                    channels = usize::from(u16_at(body + 2));
                    rate = u32_at(body + 4);
                    assert_eq!(u16_at(body + 14), 16, "16-bit PCM only");
                }
                b"data" => {
                    let end = (body + size).min(bytes.len());
                    let samples = bytes[body..end].chunks_exact(2).map(|pair| f32::from(i16::from_le_bytes([pair[0], pair[1]])) / 32768.0).collect();
                    return (rate, channels, samples);
                }
                _ => {}
            }
            offset = body + size + (size % 2);
        }
        panic!("no data chunk");
    }

    /// End-to-end check with a real model (not run by default):
    /// FINANCE_CHAT_TEST_MODEL=ggml-base.bin FINANCE_CHAT_TEST_WAV=fala.wav [FINANCE_CHAT_TEST_EXPECT=mercado] cargo test -- --ignored
    #[test]
    #[ignore]
    fn transcribes_portuguese_speech_with_a_real_model() {
        let model = std::env::var("FINANCE_CHAT_TEST_MODEL").expect("FINANCE_CHAT_TEST_MODEL");
        let wav = std::fs::read(std::env::var("FINANCE_CHAT_TEST_WAV").expect("FINANCE_CHAT_TEST_WAV")).unwrap();
        let (rate, channels, interleaved) = read_wav(&wav);
        let samples = audio::trim_silence(&audio::resample(&audio::to_mono(&interleaved, channels), rate, audio::WHISPER_RATE), audio::WHISPER_RATE);
        assert!(audio::rms(&samples) > SILENCE_RMS);
        let text = transcribe(std::path::Path::new(&model), &samples).expect("transcription");
        println!("transcript: {text}");
        let expected = std::env::var("FINANCE_CHAT_TEST_EXPECT").unwrap_or_else(|_| "mercado".into());
        assert!(text.to_lowercase().contains(&expected.to_lowercase()), "{text:?} should contain {expected:?}");
    }
}
