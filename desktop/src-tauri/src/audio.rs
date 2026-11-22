//! Pure audio helpers for the voice capture: mono mixdown, resampling to 16 kHz,
//! loudness, silence trimming and the WAV/base64 encoding sent to the server.

/// Sample rate of the recording sent for transcription (16 kHz is plenty for speech).
pub const SPEECH_RATE: u32 = 16_000;

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

/// Removes the silence before the first and after the last loud enough 20 ms frame
/// (keeping 200 ms around the speech). Whisper is much more likely to invent text, or to
/// repeat its prompt, when a recording starts or ends with silence. Returns an empty
/// vector when nothing is loud enough.
pub fn trim_silence(samples: &[f32], rate: u32) -> Vec<f32> {
    let frame = ((rate as usize) / 50).max(1);
    let levels: Vec<f32> = samples.chunks(frame).map(rms).collect();
    let peak = levels.iter().copied().fold(0.0_f32, f32::max);
    let threshold = (peak * 0.1).max(0.004);
    let (Some(first), Some(last)) = (levels.iter().position(|level| *level >= threshold), levels.iter().rposition(|level| *level >= threshold)) else {
        return Vec::new();
    };
    let padding = (rate as usize) / 5;
    let start = (first * frame).saturating_sub(padding);
    let end = ((last + 1) * frame + padding).min(samples.len());
    samples[start..end].to_vec()
}

/// Mono samples at [`SPEECH_RATE`] → a 16-bit PCM WAV file (what the server accepts).
pub fn encode_wav(samples: &[f32]) -> Vec<u8> {
    let data_len = (samples.len() * 2) as u32;
    let mut bytes = Vec::with_capacity(44 + data_len as usize);
    bytes.extend_from_slice(b"RIFF");
    bytes.extend_from_slice(&(36 + data_len).to_le_bytes());
    bytes.extend_from_slice(b"WAVEfmt ");
    bytes.extend_from_slice(&16u32.to_le_bytes());
    bytes.extend_from_slice(&1u16.to_le_bytes()); // PCM
    bytes.extend_from_slice(&1u16.to_le_bytes()); // mono
    bytes.extend_from_slice(&SPEECH_RATE.to_le_bytes());
    bytes.extend_from_slice(&(SPEECH_RATE * 2).to_le_bytes());
    bytes.extend_from_slice(&2u16.to_le_bytes());
    bytes.extend_from_slice(&16u16.to_le_bytes());
    bytes.extend_from_slice(b"data");
    bytes.extend_from_slice(&data_len.to_le_bytes());
    for sample in samples {
        bytes.extend_from_slice(&((sample.clamp(-1.0, 1.0) * 32767.0).round() as i16).to_le_bytes());
    }
    bytes
}

/// Standard base64 (with padding), to hand the WAV to the quick window in an event.
pub fn base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let triple = (u32::from(chunk[0]) << 16) | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8) | u32::from(*chunk.get(2).unwrap_or(&0));
        out.push(TABLE[(triple >> 18) as usize & 63] as char);
        out.push(TABLE[(triple >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { TABLE[(triple >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { TABLE[triple as usize & 63] as char } else { '=' });
    }
    out
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
        let output = resample(&one_second, 48_000, SPEECH_RATE);
        assert_eq!(output.len(), 16_000);
        assert!(output.iter().all(|sample| (sample - 0.25).abs() < 1e-6));
        let up = resample(&[0.0, 1.0], 8_000, 16_000);
        assert_eq!(up.len(), 4);
        assert!((up[1] - 0.5).abs() < 1e-6);
        assert_eq!(resample(&[], 44_100, SPEECH_RATE), Vec::<f32>::new());
        assert_eq!(resample(&[0.3; 10], 16_000, 16_000).len(), 10);
    }

    #[test]
    fn loudness_tells_silence_from_speech() {
        assert_eq!(rms(&[]), 0.0);
        assert!(rms(&[0.0; 100]) < 1e-9);
        assert!((rms(&[0.5, -0.5]) - 0.5).abs() < 1e-6);
    }

    #[test]
    fn silence_around_the_speech_is_trimmed() {
        let rate = 16_000;
        let mut samples = vec![0.0_f32; 16_000];
        samples.extend((0..8_000).map(|index| (index as f32 * 0.05).sin() * 0.3));
        samples.extend(vec![0.001_f32; 32_000]);
        let trimmed = trim_silence(&samples, rate);
        // 0.5 s of speech plus about 200 ms on each side.
        assert!(trimmed.len() >= 8_000 && trimmed.len() <= 8_000 + 2 * 3_200 + 640, "{}", trimmed.len());
        assert!(trim_silence(&vec![0.0005_f32; 16_000], rate).is_empty());
        assert!(trim_silence(&[], rate).is_empty());
    }

    #[test]
    fn wav_and_base64_encoding() {
        let wav = encode_wav(&[0.0, 1.0, -1.0, 0.5]);
        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(&wav[8..16], b"WAVEfmt ");
        assert_eq!(u32::from_le_bytes([wav[24], wav[25], wav[26], wav[27]]), 16_000);
        assert_eq!(wav.len(), 44 + 8);
        assert_eq!(i16::from_le_bytes([wav[46], wav[47]]), 32767);
        assert_eq!(i16::from_le_bytes([wav[48], wav[49]]), -32767);
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
        assert_eq!(base64(&[255, 254, 253]), "//79");
    }
}
