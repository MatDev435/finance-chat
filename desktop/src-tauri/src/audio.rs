//! Pure audio helpers for the voice capture: mono mixdown, resampling to the
//! 16 kHz that Whisper expects, loudness and transcript clean-up.

/// Sample rate expected by Whisper.
pub const WHISPER_RATE: u32 = 16_000;

/// Interleaved frames → mono (average of the channels).
pub fn to_mono(interleaved: &[f32], channels: usize) -> Vec<f32> {
    if channels <= 1 {
        return interleaved.to_vec();
    }
    interleaved.chunks(channels).map(|frame| frame.iter().sum::<f32>() / frame.len() as f32).collect()
}

/// Resamples mono audio. When reducing the rate, each output sample is the
/// average of the input samples it covers (a box filter), which removes most
/// of the aliasing for speech; when increasing it, linear interpolation.
pub fn resample(samples: &[f32], from_rate: u32, to_rate: u32) -> Vec<f32> {
    if samples.is_empty() || from_rate == 0 || to_rate == 0 || from_rate == to_rate {
        return samples.to_vec();
    }
    let ratio = from_rate as f64 / to_rate as f64;
    let length = ((samples.len() as f64) / ratio).floor() as usize;
    let mut output = Vec::with_capacity(length);
    for index in 0..length {
        let position = index as f64 * ratio;
        if ratio > 1.0 {
            let start = position.floor() as usize;
            let end = ((position + ratio).ceil() as usize).min(samples.len()).max(start + 1);
            let window = &samples[start..end];
            output.push(window.iter().sum::<f32>() / window.len() as f32);
        } else {
            let base = position.floor() as usize;
            let next = (base + 1).min(samples.len() - 1);
            let fraction = (position - base as f64) as f32;
            output.push(samples[base] * (1.0 - fraction) + samples[next] * fraction);
        }
    }
    output
}

/// Root mean square (0 for silence, about 0.7 for a full-scale sine).
pub fn rms(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    (samples.iter().map(|sample| sample * sample).sum::<f32>() / samples.len() as f32).sqrt()
}

/// Phrases Whisper is known to "hear" in silence or noise (subtitles credits and the like).
const HALLUCINATIONS: &[&str] = &[
    "legendas pela comunidade amara.org",
    "legendas pela comunidade amara.org.",
    "obrigado.",
    "obrigada.",
    "obrigado por assistir.",
    "inscreva-se no canal.",
    "tchau.",
    "...",
];

/// Joins the segments, drops annotations such as "[Música]" and known hallucinations.
pub fn clean_transcript(raw: &str) -> String {
    let mut text = String::with_capacity(raw.len());
    let mut depth = 0usize;
    for character in raw.chars() {
        match character {
            '[' => depth += 1,
            ']' if depth > 0 => depth -= 1,
            _ if depth == 0 => text.push(character),
            _ => {}
        }
    }
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if HALLUCINATIONS.contains(&text.to_lowercase().as_str()) {
        return String::new();
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stereo_frames_become_mono() {
        assert_eq!(to_mono(&[1.0, 0.0, 0.5, 0.5], 2), vec![0.5, 0.5]);
        assert_eq!(to_mono(&[0.1, 0.2], 1), vec![0.1, 0.2]);
    }

    #[test]
    fn resampling_keeps_the_duration_and_the_level() {
        let one_second = vec![0.25_f32; 48_000];
        let output = resample(&one_second, 48_000, WHISPER_RATE);
        assert_eq!(output.len(), 16_000);
        assert!(output.iter().all(|sample| (sample - 0.25).abs() < 1e-6));
        let up = resample(&[0.0, 1.0], 8_000, 16_000);
        assert_eq!(up.len(), 4);
        assert!((up[1] - 0.5).abs() < 1e-6);
        assert_eq!(resample(&[], 44_100, WHISPER_RATE), Vec::<f32>::new());
        assert_eq!(resample(&[0.3; 10], 16_000, 16_000).len(), 10);
    }

    #[test]
    fn loudness_tells_silence_from_speech() {
        assert_eq!(rms(&[]), 0.0);
        assert!(rms(&[0.0; 100]) < 1e-9);
        assert!((rms(&[0.5, -0.5]) - 0.5).abs() < 1e-6);
    }

    #[test]
    fn transcripts_are_cleaned() {
        assert_eq!(clean_transcript(" Gastei 40 reais  no mercado. [Música] "), "Gastei 40 reais no mercado.");
        assert_eq!(clean_transcript("[BLANK_AUDIO]"), "");
        assert_eq!(clean_transcript(" Legendas pela comunidade Amara.org "), "");
        assert_eq!(clean_transcript("Obrigado."), "");
        assert_eq!(clean_transcript("Obrigado pela ajuda, gastei 10 no café"), "Obrigado pela ajuda, gastei 10 no café");
    }
}
