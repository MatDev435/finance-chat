//! Voice capture (push to talk).
//!
//! Holding the global shortcut (or clicking the microphone in the quick window)
//! starts a capture thread that owns the microphone stream; releasing it (or
//! clicking again) stops the capture. The recording is reduced to 16 kHz mono,
//! the silence around the speech is trimmed, and the WAV goes to the quick
//! window ("voice://state" with state "audio"), which uploads it to the Finance
//! Chat server; the server transcribes it with OpenAI using the user's own AI
//! key and records the cost. The quick window shows and announces every step;
//! sound cues mark the start and the end of the recording. The text only fills
//! the message field: nothing is sent to the chat without the user.

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
use crate::{audio, windows, AppState};

/// A recording stops by itself after this long (the server accepts up to 90 s).
const MAX_RECORDING: Duration = Duration::from_secs(60);
/// Shorter recordings (after trimming the silence) are treated as "nothing said".
const MIN_SPEECH_SECONDS: f32 = 0.35;
/// Below this loudness (RMS) the recording is treated as silence (and never uploaded).
const SILENCE_RMS: f32 = 0.003;

#[derive(Default)]
pub struct Voice {
    stop: Mutex<Option<Sender<()>>>,
    busy: AtomicBool,
}

impl Voice {
    /// Recording (or preparing the audio).
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

/// Voice capture only needs a microphone (the transcription happens on the server).
pub fn ready(_app: &AppHandle) -> bool {
    true
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

/// Shortcut released: stop listening and hand the audio to the quick window.
pub fn hold_end(app: &AppHandle) {
    app.state::<AppState>().voice.request_stop();
}

/// Microphone button of the quick window: start, or stop.
pub fn toggle(app: &AppHandle) {
    let voice = &app.state::<AppState>().voice;
    if voice.recording() {
        voice.request_stop();
    } else {
        start(app);
    }
}

/// The quick page finished loading: tell it about a recording already in progress.
pub fn resend_state(app: &AppHandle) {
    if app.state::<AppState>().voice.recording() {
        emit(app, json!({ "state": "recording" }));
    }
}

fn start(app: &AppHandle) {
    let state = app.state::<AppState>();
    if state.voice.busy.swap(true, Ordering::SeqCst) {
        return; // already recording
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
                let samples = audio::trim_silence(&audio::resample(&mono, rate, audio::SPEECH_RATE), audio::SPEECH_RATE);
                let seconds = samples.len() as f32 / audio::SPEECH_RATE as f32;
                if seconds < MIN_SPEECH_SECONDS || audio::rms(&samples) < SILENCE_RMS {
                    emit(&app, json!({ "state": "done", "text": "" }));
                } else {
                    let wav = audio::encode_wav(&samples);
                    emit(&app, json!({ "state": "audio", "wav": audio::base64(&wav), "durationMs": (seconds * 1000.0).round() as u64 }));
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
        // Exactly the cue: it means "speak now", and cutting into the first word hurts the transcription.
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
