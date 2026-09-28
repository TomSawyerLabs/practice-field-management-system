import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  MATCH_SOUND_LUFS,
  MATCH_SOUND_PEAK_CEILING_DBFS,
  integratedLoudness,
  readWav,
  samplePeakDbfs,
  type PcmAudio,
} from './loudness.js';

const SOUNDS_DIR = resolve(__dirname, '..', 'sounds');

/** How far a clip may sit from MATCH_SOUND_LUFS — just under 1 dB of spread between any two clips. */
const TOLERANCE_LU = 0.5;

/** A limiter set to the ceiling can round to a 16-bit sample a hair above it (~0.0004 dB). */
const PEAK_QUANTIZATION_DB = 0.01;

const clips = readdirSync(SOUNDS_DIR)
  .filter(name => name.endsWith('.wav'))
  .sort();

describe('match sounds all play at the same level', () => {
  test('sounds/ has clips to check', () => {
    expect(clips.length).toBeGreaterThan(0);
  });

  for (const clip of clips) {
    describe(clip, () => {
      const audio = readWav(readFileSync(resolve(SOUNDS_DIR, clip)));

      // Out of range? Level it with the ffmpeg recipe in docs/match-system.md
      // (or, for pause/resume321, rerun scripts/generate-sounds.ts --force).
      test(`integrated loudness is ${MATCH_SOUND_LUFS} ±${TOLERANCE_LU} LUFS`, () => {
        const lufs = integratedLoudness(audio);
        expect(lufs).toBeGreaterThanOrEqual(MATCH_SOUND_LUFS - TOLERANCE_LU);
        expect(lufs).toBeLessThanOrEqual(MATCH_SOUND_LUFS + TOLERANCE_LU);
      });

      test(`peaks at or below ${MATCH_SOUND_PEAK_CEILING_DBFS} dBFS`, () => {
        expect(samplePeakDbfs(audio)).toBeLessThanOrEqual(MATCH_SOUND_PEAK_CEILING_DBFS + PEAK_QUANTIZATION_DB);
      });
    });
  }
});

function sine(sampleRate: number, seconds: number, freq: number, amplitude: number): Float32Array {
  const samples = new Float32Array(Math.round(sampleRate * seconds));
  for (let i = 0; i < samples.length; i++) samples[i] = amplitude * Math.sin((2 * Math.PI * freq * i) / sampleRate);
  return samples;
}

/** Encode mono samples as a minimal PCM WAV. */
function wav(samples: Float32Array, sampleRate: number, bits: 8 | 16): Buffer {
  const bytes = bits / 8;
  const data = Buffer.alloc(samples.length * bytes);
  samples.forEach((s, i) => {
    if (bits === 8) data[i] = Math.round(s * 127) + 128;
    else data.writeInt16LE(Math.round(s * 32767), i * 2);
  });
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * bytes, 28);
  header.writeUInt16LE(bytes, 32);
  header.writeUInt16LE(bits, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

describe('loudness meter', () => {
  // BS.1770 calibration: a 1 kHz sine at amplitude A in one channel reads
  // 20·log10(A) − 3.01 LUFS. Checked at every sample rate sounds/ uses, since
  // the K-weighting filters are designed per rate.
  for (const sampleRate of [11025, 22050, 44100, 48000]) {
    test(`reads a -20 dBFS 1 kHz sine as -23.01 LUFS at ${sampleRate} Hz`, () => {
      const audio: PcmAudio = { sampleRate, channels: [sine(sampleRate, 3, 1000, 0.1)] };
      expect(integratedLoudness(audio)).toBeCloseTo(-23.01, 1);
    });
  }

  test('sums channels: the same sine in both stereo channels reads 3 LU louder', () => {
    const channel = sine(48000, 3, 1000, 0.1);
    expect(integratedLoudness({ sampleRate: 48000, channels: [channel, channel] })).toBeCloseTo(-20.0, 1);
  });

  test('gates out silence, so a pause inside a clip does not drag its loudness down', () => {
    // 2 s of tone between 2 s of silence on each side. Of the 57 blocks, the
    // 36 near-silent ones are gated out; what's left is 17 blocks fully in
    // the tone plus 3 per edge holding 25/50/75% of it — which stay above the
    // relative gate, as BS.1770 intends. Ungated it would read ~4.6 LU lower.
    const tone = sine(48000, 2, 1000, 0.1);
    const padded = new Float32Array(tone.length * 3);
    padded.set(tone, tone.length);
    const expected = -23.01 + 10 * Math.log10((17 + 2 * (0.25 + 0.5 + 0.75)) / 23);
    expect(integratedLoudness({ sampleRate: 48000, channels: [padded] })).toBeCloseTo(expected, 1);
  });

  test('reads silence as -Infinity', () => {
    expect(integratedLoudness({ sampleRate: 48000, channels: [new Float32Array(48000)] })).toBe(-Infinity);
  });

  test('decodes 8-bit (unsigned) and 16-bit WAV to the same levels', () => {
    // At a quarter of the sample rate every sample lands on 0 or ±peak exactly.
    const tone = sine(11025, 1, 11025 / 4, 0.5);
    for (const bits of [8, 16] as const) {
      const audio = readWav(wav(tone, 11025, bits));
      expect(audio.sampleRate).toBe(11025);
      expect(audio.channels[0].length).toBe(tone.length);
      expect(samplePeakDbfs(audio)).toBeCloseTo(20 * Math.log10(0.5), 1);
    }
  });
});
