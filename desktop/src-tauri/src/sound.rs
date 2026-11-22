//! Short sound cues for the voice capture, synthesized on the fly (no audio files):
//! a rising pair of tones when the microphone starts listening, a falling pair when
//! it stops, a low tone on errors. They complement the visual state and the screen
//! reader announcements of the quick window.

use std::f32::consts::PI;
use std::thread;
use std::time::Duration;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, SampleFormat, SizedSample, StreamConfig};

#[derive(Clone, Copy, Debug)]
pub enum Cue {
    Start,
    Stop,
    Error,
}

impl Cue {
    /// (frequency in Hz, duration in ms) of each tone.
    fn tones(self) -> &'static [(f32, u32)] {
        match self {
            Cue::Start => &[(660.0, 70), (990.0, 90)],
            Cue::Stop => &[(990.0, 70), (660.0, 90)],
            Cue::Error => &[(330.0, 220)],
        }
    }

    pub fn duration(self) -> Duration {
        Duration::from_millis(self.tones().iter().map(|(_, ms)| u64::from(*ms)).sum())
    }
}

const VOLUME: f32 = 0.22;
const FADE_SECONDS: f32 = 0.006;

/// Mono samples of a cue at the given sample rate, with short fades (no clicks).
pub fn render(cue: Cue, sample_rate: u32) -> Vec<f32> {
    let rate = sample_rate as f32;
    let mut samples = Vec::new();
    for &(frequency, millis) in cue.tones() {
        let count = (rate * millis as f32 / 1000.0) as usize;
        let fade = ((rate * FADE_SECONDS) as usize).max(1);
        for index in 0..count {
            let envelope = (index.min(count - 1 - index) as f32 / fade as f32).min(1.0);
            samples.push((2.0 * PI * frequency * index as f32 / rate).sin() * VOLUME * envelope);
        }
    }
    samples
}

/// Plays a cue on the default output device without blocking the caller.
pub fn play(cue: Cue) {
    thread::spawn(move || {
        let _ = play_blocking(cue);
    });
}

fn play_blocking(cue: Cue) -> Result<(), String> {
    let device = cpal::default_host().default_output_device().ok_or("no output device")?;
    let supported = device.default_output_config().map_err(|error| error.to_string())?;
    let format = supported.sample_format();
    let config: StreamConfig = supported.into();
    let samples = render(cue, config.sample_rate);
    match format {
        SampleFormat::F32 => stream::<f32>(&device, config, samples, cue),
        SampleFormat::I16 => stream::<i16>(&device, config, samples, cue),
        SampleFormat::U16 => stream::<u16>(&device, config, samples, cue),
        SampleFormat::I32 => stream::<i32>(&device, config, samples, cue),
        other => Err(format!("unsupported output format {other}")),
    }
}

fn stream<T>(device: &cpal::Device, config: StreamConfig, samples: Vec<f32>, cue: Cue) -> Result<(), String>
where
    T: SizedSample + FromSample<f32>,
{
    let channels = usize::from(config.channels);
    let mut position = 0usize;
    let stream = device
        .build_output_stream(
            config,
            move |output: &mut [T], _: &cpal::OutputCallbackInfo| {
                for frame in output.chunks_mut(channels) {
                    let value = samples.get(position).copied().unwrap_or(0.0);
                    position += 1;
                    for sample in frame.iter_mut() {
                        *sample = T::from_sample(value);
                    }
                }
            },
            |_| {},
            None,
        )
        .map_err(|error| error.to_string())?;
    stream.play().map_err(|error| error.to_string())?;
    thread::sleep(cue.duration() + Duration::from_millis(80));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cues_are_short_quiet_and_start_and_end_silent() {
        let start = render(Cue::Start, 48_000);
        assert_eq!(start.len(), 48_000 * 160 / 1000);
        assert!(start.iter().all(|sample| sample.abs() <= VOLUME + 1e-6));
        assert!(start[0].abs() < 1e-6 && start.last().unwrap().abs() < 0.05);
        assert_eq!(Cue::Error.duration(), Duration::from_millis(220));
    }
}
