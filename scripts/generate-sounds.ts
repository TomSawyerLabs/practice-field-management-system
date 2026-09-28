/**
 * Synthesize the match sounds that aren't voice recordings.
 *
 * `pause.wav` and `resume321.wav` are simple tonal cues, so they're generated
 * here rather than checked in as opaque binaries — regenerate with
 * `bun scripts/generate-sounds.ts` and tweak the constants below to taste.
 * The spoken clips (countdown1-4, getready) and the horns/buzzers are real
 * recordings and are NOT touched by this script.
 *
 * `resume321.wav` follows the same contract as countdown1-4.wav: cue tones at
 * 0/1/2 seconds and the "you are live" tone at exactly 3.0 seconds, because
 * the match engine re-enables robots 3 seconds after the clip starts. Keep it
 * a single clip — the server holds the ALSA device exclusively, so
 * back-to-back clips race each other and drop sounds.
 */
import { writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  MATCH_SOUND_LUFS,
  MATCH_SOUND_PEAK_CEILING_DBFS,
  integratedLoudness,
  samplePeakDbfs,
} from '../src/loudness.js';

const SAMPLE_RATE = 44100;
const SOUNDS_DIR = resolve(__dirname, '..', 'sounds');

/** Render into a mono float buffer, then quantize to 16-bit PCM at the end. */
class Track {
  readonly samples: Float32Array;

  constructor(durationSeconds: number) {
    this.samples = new Float32Array(Math.ceil(durationSeconds * SAMPLE_RATE));
  }

  /**
   * Mix in a tone. `harmonics` adds quieter multiples of the base frequency,
   * which keeps the result from sounding like a bare sine test tone through a
   * field PA. Frequencies glide from `freq` to `endFreq` when both are given.
   */
  tone(
    startSeconds: number,
    durationSeconds: number,
    freq: number,
    {
      gain = 0.6,
      endFreq = freq,
      harmonics = [0.3, 0.12],
    }: { gain?: number; endFreq?: number; harmonics?: number[] } = {},
  ): void {
    const start = Math.floor(startSeconds * SAMPLE_RATE);
    const length = Math.floor(durationSeconds * SAMPLE_RATE);
    // 8ms ramps top and tail — without them the discontinuity clicks audibly.
    const ramp = Math.min(Math.floor(0.008 * SAMPLE_RATE), Math.floor(length / 2));

    let phase = 0;
    for (let i = 0; i < length; i++) {
      const index = start + i;
      if (index >= this.samples.length) break;

      const t = i / length;
      const instantaneous = freq + (endFreq - freq) * t;
      phase += (2 * Math.PI * instantaneous) / SAMPLE_RATE;

      let value = Math.sin(phase);
      for (let h = 0; h < harmonics.length; h++) {
        value += harmonics[h] * Math.sin(phase * (h + 2));
      }

      let envelope = 1;
      if (i < ramp) envelope = i / ramp;
      else if (i > length - ramp) envelope = (length - i) / ramp;

      this.samples[index] += value * gain * envelope;
    }
  }

  /**
   * Scale to the loudness every match sound shares (enforced by
   * src/sounds.test.ts). The `gain`s passed to tone() set the balance within
   * a clip; this sets its overall level.
   */
  level(): this {
    const audio = { sampleRate: SAMPLE_RATE, channels: [this.samples] };
    const gain = 10 ** ((MATCH_SOUND_LUFS - integratedLoudness(audio)) / 20);
    for (let i = 0; i < this.samples.length; i++) this.samples[i] *= gain;
    const peak = samplePeakDbfs(audio);
    if (peak > MATCH_SOUND_PEAK_CEILING_DBFS) {
      throw new Error(
        `At ${MATCH_SOUND_LUFS} LUFS this clip peaks at ${peak.toFixed(1)} dBFS, above the ` +
          `${MATCH_SOUND_PEAK_CEILING_DBFS} dBFS ceiling. Make the loudest tone less dominant.`,
      );
    }
    return this;
  }

  toWav(): Buffer {
    const data = Buffer.alloc(this.samples.length * 2);
    for (let i = 0; i < this.samples.length; i++) {
      // Clamp rather than wrap: summed harmonics can exceed unity.
      const clamped = Math.max(-1, Math.min(1, this.samples[i]));
      data.writeInt16LE(Math.round(clamped * 32767), i * 2);
    }

    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + data.length, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16); // PCM chunk size
    header.writeUInt16LE(1, 20); // format: PCM
    header.writeUInt16LE(1, 22); // channels: mono
    header.writeUInt32LE(SAMPLE_RATE, 24);
    header.writeUInt32LE(SAMPLE_RATE * 2, 28); // byte rate
    header.writeUInt16LE(2, 32); // block align
    header.writeUInt16LE(16, 34); // bits per sample
    header.write('data', 36);
    header.writeUInt32LE(data.length, 40);

    return Buffer.concat([header, data]);
  }
}

/** Two descending notes — reads as "stop, hold" rather than as an alarm. */
function buildPause(): Track {
  const track = new Track(0.75);
  track.tone(0, 0.18, 740, { gain: 0.5 });
  track.tone(0.2, 0.34, 554, { gain: 0.5 });
  return track;
}

/** Cue tones at 0/1/2s, then the "robots are live" note at exactly 3.0s. */
function buildResume321(): Track {
  const track = new Track(3.9);
  for (const second of [0, 1, 2]) {
    track.tone(second, 0.22, 660, { gain: 0.45 });
  }
  // Rising two-note figure so it can't be mistaken for another count tone.
  track.tone(3.0, 0.22, 660, { gain: 0.6 });
  track.tone(3.2, 0.55, 880, { gain: 0.6, endFreq: 988 });
  return track;
}

const outputs: [string, Track][] = [
  ['pause.wav', buildPause()],
  ['resume321.wav', buildResume321()],
];

const force = process.argv.includes('--force');

for (const [name, track] of outputs) {
  const path = resolve(SOUNDS_DIR, name);
  if (existsSync(path) && !force) {
    console.log(`${name}: already exists, skipping (use --force to overwrite)`);
    continue;
  }
  const wav = track.level().toWav();
  writeFileSync(path, wav);
  console.log(`${name}: wrote ${wav.length} bytes (${(track.samples.length / SAMPLE_RATE).toFixed(2)}s)`);
}
