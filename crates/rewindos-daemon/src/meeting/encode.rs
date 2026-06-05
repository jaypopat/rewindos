//! Ogg-Opus encoding for meeting audio.
//!
//! Encodes mono f32 16 kHz PCM (as produced by `capture::audio::AudioWindow`)
//! into a standards-compliant `.opus` file. Uses the `opus` crate (bundles and
//! compiles libopus at build time via cmake — no system libopus) and the pure-
//! Rust `ogg` crate for the container. See RFC 7845 for the Ogg-Opus mapping.

use std::io::Write;

use ogg::{PacketWriteEndInfo, PacketWriter};
use opus::{Application, Channels, Encoder};

/// Capture/encode sample rate (whisper's native input; matches `AudioWindow`).
const SAMPLE_RATE: u32 = 16_000;
/// 20 ms frame at 16 kHz — the Opus frame size we encode.
const FRAME_SAMPLES: usize = 320;
/// Granule units per 20 ms frame. Ogg-Opus granule is always at 48 kHz, so
/// 20 ms = 960, regardless of the 16 kHz capture rate.
const GRANULE_PER_FRAME: u64 = 960;
/// Pre-skip (48 kHz samples) declared in OpusHead. We prepend no priming
/// samples, so this is 0 — a non-zero value would make decoders trim real
/// audio off the front of the recording.
const PRE_SKIP: u16 = 0;
/// Logical-stream serial. Each file is its own physical stream, so a fixed
/// value is fine. ASCII "RWOS".
const SERIAL: u32 = 0x5257_4F53;
/// Safe upper bound on a single Opus packet (libopus convention).
const MAX_PACKET: usize = 4000;

/// Errors from Opus encoding or Ogg writing.
#[derive(Debug, thiserror::Error)]
pub enum EncodeError {
    #[error("opus error: {0}")]
    Opus(#[from] opus::Error),
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
}

/// Build the 19-byte OpusHead identification header (RFC 7845 §5.1),
/// channel mapping family 0 (mono/stereo, no mapping table).
fn opus_head(channels: u8, input_sample_rate: u32, pre_skip: u16) -> Vec<u8> {
    let mut h = Vec::with_capacity(19);
    h.extend_from_slice(b"OpusHead");
    h.push(1); // version
    h.push(channels);
    h.extend_from_slice(&pre_skip.to_le_bytes());
    h.extend_from_slice(&input_sample_rate.to_le_bytes());
    h.extend_from_slice(&0i16.to_le_bytes()); // output gain (Q7.8 dB)
    h.push(0); // channel mapping family 0
    h
}

/// Build a minimal OpusTags comment header (RFC 7845 §5.2): the given vendor
/// string and zero user comments.
fn opus_tags(vendor: &str) -> Vec<u8> {
    let mut t = Vec::new();
    t.extend_from_slice(b"OpusTags");
    t.extend_from_slice(&(vendor.len() as u32).to_le_bytes());
    t.extend_from_slice(vendor.as_bytes());
    t.extend_from_slice(&0u32.to_le_bytes()); // user comment list length
    t
}

/// Streaming Ogg-Opus encoder. Emits the header pages on construction, encodes
/// 20 ms frames as PCM arrives, and flags end-of-stream on `finalize`.
pub struct OpusWriter<W: Write> {
    writer: PacketWriter<'static, W>,
    encoder: Encoder,
    /// Samples not yet forming a complete 320-sample frame.
    pending: Vec<f32>,
    /// Most-recently-encoded packet, held back so `finalize` can flag EOS on
    /// the true last packet.
    held: Option<Vec<u8>>,
    /// Running granule position, in 48 kHz samples.
    granule: u64,
}

impl<W: Write> OpusWriter<W> {
    /// Create a writer over `sink`, emitting OpusHead + OpusTags immediately.
    pub fn new(sink: W) -> Result<Self, EncodeError> {
        let encoder = Encoder::new(SAMPLE_RATE, Channels::Mono, Application::Voip)?;
        let mut writer = PacketWriter::new(sink);
        writer.write_packet(
            opus_head(1, SAMPLE_RATE, PRE_SKIP),
            SERIAL,
            PacketWriteEndInfo::EndPage,
            0,
        )?;
        writer.write_packet(
            opus_tags("rewindos"),
            SERIAL,
            PacketWriteEndInfo::EndPage,
            0,
        )?;
        Ok(Self {
            writer,
            encoder,
            pending: Vec::new(),
            held: None,
            granule: 0,
        })
    }

    /// Append PCM (mono f32 @ 16 kHz). Encodes every complete 20 ms frame;
    /// leftover samples are buffered for the next call or `finalize`.
    pub fn push(&mut self, samples: &[f32]) -> Result<(), EncodeError> {
        self.pending.extend_from_slice(samples);
        let mut out = [0u8; MAX_PACKET];
        while self.pending.len() >= FRAME_SAMPLES {
            let frame: Vec<f32> = self.pending.drain(..FRAME_SAMPLES).collect();
            let n = self.encoder.encode_float(&frame, &mut out)?;
            self.stage(out[..n].to_vec())?;
        }
        Ok(())
    }

    /// Finalize: zero-pad any partial frame, write the held packet with the
    /// end-of-stream flag, and flush the underlying writer to disk. Takes
    /// `self` by value so the writer can't be used after the stream is closed.
    pub fn finalize(mut self) -> Result<(), EncodeError> {
        if !self.pending.is_empty() {
            let mut out = [0u8; MAX_PACKET];
            self.pending.resize(FRAME_SAMPLES, 0.0);
            let frame = std::mem::take(&mut self.pending);
            let n = self.encoder.encode_float(&frame, &mut out)?;
            self.stage(out[..n].to_vec())?;
        }
        if let Some(last) = self.held.take() {
            self.granule += GRANULE_PER_FRAME;
            self.writer
                .write_packet(last, SERIAL, PacketWriteEndInfo::EndStream, self.granule)?;
        }
        // Flush explicitly rather than leaning on BufWriter's drop, which would
        // silently discard a flush error and make this fallible method lie.
        self.writer.into_inner().flush()?;
        Ok(())
    }

    /// Flush the currently-held packet as a normal page, then hold `packet`.
    /// Keeping one packet in hand lets `finalize` flag EOS on the real last one.
    fn stage(&mut self, packet: Vec<u8>) -> Result<(), EncodeError> {
        if let Some(prev) = self.held.take() {
            self.granule += GRANULE_PER_FRAME;
            self.writer
                .write_packet(prev, SERIAL, PacketWriteEndInfo::NormalPacket, self.granule)?;
        }
        self.held = Some(packet);
        Ok(())
    }
}

impl OpusWriter<std::io::BufWriter<std::fs::File>> {
    /// Create an Ogg-Opus file at `path`. The parent directory must exist.
    pub fn create(path: impl AsRef<std::path::Path>) -> Result<Self, EncodeError> {
        let file = std::fs::File::create(path)?;
        Self::new(std::io::BufWriter::new(file))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_then_finalize_writes_two_header_packets() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("h.opus");

        let w = OpusWriter::create(&path).unwrap();
        w.finalize().unwrap(); // no audio — just the headers

        let bytes = std::fs::read(&path).unwrap();
        let mut rdr = ogg::PacketReader::new(std::io::Cursor::new(bytes));

        let p0 = rdr.read_packet().unwrap().expect("OpusHead packet");
        assert_eq!(&p0.data[0..8], b"OpusHead");
        assert_eq!(p0.absgp_page(), 0);

        let p1 = rdr.read_packet().unwrap().expect("OpusTags packet");
        assert_eq!(&p1.data[0..8], b"OpusTags");
        assert_eq!(p1.absgp_page(), 0);
    }

    #[test]
    fn opus_head_layout_mono_16k() {
        let h = opus_head(1, 16_000, 0);
        assert_eq!(h.len(), 19);
        assert_eq!(&h[0..8], b"OpusHead");
        assert_eq!(h[8], 1, "version");
        assert_eq!(h[9], 1, "channel count");
        assert_eq!(u16::from_le_bytes([h[10], h[11]]), 0, "pre-skip");
        assert_eq!(
            u32::from_le_bytes([h[12], h[13], h[14], h[15]]),
            16_000,
            "input sample rate"
        );
        assert_eq!(i16::from_le_bytes([h[16], h[17]]), 0, "output gain");
        assert_eq!(h[18], 0, "channel mapping family");
    }

    #[test]
    fn opus_tags_has_magic_vendor_and_zero_comments() {
        let t = opus_tags("rewindos");
        assert_eq!(&t[0..8], b"OpusTags");
        let vlen = u32::from_le_bytes([t[8], t[9], t[10], t[11]]) as usize;
        assert_eq!(vlen, "rewindos".len());
        assert_eq!(&t[12..12 + vlen], b"rewindos");
        let count = u32::from_le_bytes([
            t[12 + vlen],
            t[13 + vlen],
            t[14 + vlen],
            t[15 + vlen],
        ]);
        assert_eq!(count, 0, "user comment count");
    }

    #[test]
    fn one_second_of_audio_reports_one_second_granule_and_eos() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.opus");

        let mut w = OpusWriter::create(&path).unwrap();
        // 1.0 s mono @ 16 kHz = 16000 samples = exactly 50 frames of 320.
        w.push(&vec![0.25f32; 16_000]).unwrap();
        w.finalize().unwrap();

        let bytes = std::fs::read(&path).unwrap();
        let mut rdr = ogg::PacketReader::new(std::io::Cursor::new(bytes));
        let mut last_granule = 0u64;
        let mut last_eos = false;
        while let Some(pkt) = rdr.read_packet().unwrap() {
            last_granule = pkt.absgp_page();
            last_eos = pkt.last_in_stream();
        }
        // 50 frames * 960 granule-per-frame (48 kHz) = 48000; ÷48000 = 1.0 s.
        assert_eq!(last_granule, 48_000);
        assert!(last_eos, "final page must carry the end-of-stream flag");
    }

    #[test]
    fn partial_final_frame_is_padded_and_file_decodes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("b.opus");

        let mut w = OpusWriter::create(&path).unwrap();
        // 8100 samples = 25 full frames (8000) + 100 leftover → padded to 1 more.
        w.push(&vec![0.1f32; 8_100]).unwrap();
        w.finalize().unwrap();

        // Decode the produced file back with libopus and count samples.
        let bytes = std::fs::read(&path).unwrap();
        let mut rdr = ogg::PacketReader::new(std::io::Cursor::new(bytes));
        let mut dec = opus::Decoder::new(16_000, opus::Channels::Mono).unwrap();
        let mut total = 0usize;
        let mut idx = 0;
        while let Some(pkt) = rdr.read_packet().unwrap() {
            if idx < 2 {
                idx += 1; // skip OpusHead + OpusTags
                continue;
            }
            let mut out = vec![0f32; 5760]; // ≥ any single-frame decode
            total += dec.decode_float(&pkt.data, &mut out, false).unwrap();
        }
        // 25 full + 1 padded = 26 frames * 320 samples = 8320.
        assert_eq!(total, 26 * 320);
    }
}
