/**
 * Loudness of match sound clips: a WAV reader plus ITU-R BS.1770-4 integrated
 * loudness — the K-weighting and gating that ffmpeg's `ebur128` filter uses —
 * so the sound-level test and `scripts/generate-sounds.ts` agree on levels
 * without shelling out to ffmpeg.
 */

/** Integrated loudness every clip in `sounds/` is levelled to. */
export const MATCH_SOUND_LUFS = -14;

/** No sample in any clip may exceed this. */
export const MATCH_SOUND_PEAK_CEILING_DBFS = -1;

/** Decoded PCM, one array per channel, samples scaled to [-1, 1). */
export interface PcmAudio {
  sampleRate: number;
  channels: Float32Array[];
}

interface WavFormat {
  format: number;
  channelCount: number;
  sampleRate: number;
  bits: number;
}

/** Parse a RIFF/WAVE file of integer (8/16/24/32-bit) or float (32/64-bit) PCM. */
export function readWav(buf: Buffer): PcmAudio {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE file');
  }
  let fmt: WavFormat | undefined;
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') {
      let format = buf.readUInt16LE(body);
      // WAVE_FORMAT_EXTENSIBLE carries the real format in its subformat GUID.
      if (format === 0xfffe) format = buf.readUInt16LE(body + 24);
      fmt = {
        format,
        channelCount: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bits: buf.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      if (!fmt) throw new Error('WAV data chunk comes before its fmt chunk');
      return decode(buf.subarray(body, Math.min(body + size, buf.length)), fmt);
    }
    // Chunks are word-aligned: an odd-sized chunk is followed by a pad byte.
    offset = body + size + (size & 1);
  }
  throw new Error('WAV has no data chunk');
}

function decode(data: Buffer, { format, channelCount, sampleRate, bits }: WavFormat): PcmAudio {
  const read = sampleReader(format, bits);
  const bytes = bits / 8;
  const frames = Math.floor(data.length / (bytes * channelCount));
  const channels = Array.from({ length: channelCount }, () => new Float32Array(frames));
  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < channelCount; c++) {
      channels[c][f] = read(data, (f * channelCount + c) * bytes);
    }
  }
  return { sampleRate, channels };
}

function sampleReader(format: number, bits: number): (data: Buffer, offset: number) => number {
  if (format === 1) {
    // 8-bit WAV is unsigned; wider integer PCM is signed.
    if (bits === 8) return (d, o) => (d[o] - 128) / 128;
    if (bits === 16) return (d, o) => d.readInt16LE(o) / 0x8000;
    if (bits === 24) return (d, o) => d.readIntLE(o, 3) / 0x800000;
    if (bits === 32) return (d, o) => d.readInt32LE(o) / 0x80000000;
  }
  if (format === 3 && bits === 32) return (d, o) => d.readFloatLE(o);
  if (format === 3 && bits === 64) return (d, o) => d.readDoubleLE(o);
  throw new Error(`unsupported WAV sample format ${format} at ${bits} bits`);
}

/** Highest absolute sample across all channels, in dBFS. */
export function samplePeakDbfs({ channels }: PcmAudio): number {
  let peak = 0;
  for (const channel of channels) {
    for (const sample of channel) peak = Math.max(peak, Math.abs(sample));
  }
  return 20 * Math.log10(peak);
}

interface Biquad {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

/**
 * The two K-weighting stages, designed for any sample rate from their analog
 * prototypes (the same constants libebur128 and ffmpeg use), so an 11 kHz
 * clip is weighted the same as a 48 kHz one.
 */
function kWeighting(sampleRate: number): Biquad[] {
  // Stage 1: high shelf, about +4 dB above 1.5 kHz (the head's acoustic effect).
  let K = Math.tan((Math.PI * 1681.974450955533) / sampleRate);
  let Q = 0.7071752369554196;
  const Vh = 10 ** (3.999843853973347 / 20);
  const Vb = Vh ** 0.4996667741545416;
  let a0 = 1 + K / Q + K * K;
  const shelf = {
    b0: (Vh + (Vb * K) / Q + K * K) / a0,
    b1: (2 * (K * K - Vh)) / a0,
    b2: (Vh - (Vb * K) / Q + K * K) / a0,
    a1: (2 * (K * K - 1)) / a0,
    a2: (1 - K / Q + K * K) / a0,
  };

  // Stage 2: the "RLB" high-pass at about 38 Hz.
  K = Math.tan((Math.PI * 38.13547087602444) / sampleRate);
  Q = 0.5003270373238773;
  a0 = 1 + K / Q + K * K;
  const highPass = { b0: 1, b1: -2, b2: 1, a1: (2 * (K * K - 1)) / a0, a2: (1 - K / Q + K * K) / a0 };

  return [shelf, highPass];
}

function filter(input: ArrayLike<number>, { b0, b1, b2, a1, a2 }: Biquad): Float64Array {
  const output = new Float64Array(input.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < input.length; i++) {
    const x = input[i];
    const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    output[i] = y;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
  }
  return output;
}

const blockLoudness = (power: number) => -0.691 + 10 * Math.log10(power);
const mean = (values: number[]) => values.reduce((sum, v) => sum + v, 0) / values.length;

/**
 * BS.1770-4 integrated loudness in LUFS: K-weighted mean square over 400 ms
 * blocks stepped by 100 ms, gated at -70 LUFS absolute and then 10 LU below
 * the absolute-gated level. Mono and left/right channels are weighted 1.0.
 * Returns -Infinity for a clip that is silent or shorter than one block.
 */
export function integratedLoudness(audio: PcmAudio): number {
  const stages = kWeighting(audio.sampleRate);
  const weighted = audio.channels.map(channel => filter(filter(channel, stages[0]), stages[1]));

  const blockSize = Math.round(0.4 * audio.sampleRate);
  const step = Math.round(0.1 * audio.sampleRate);
  const frames = weighted[0]?.length ?? 0;

  const powers: number[] = [];
  for (let start = 0; start + blockSize <= frames; start += step) {
    let power = 0;
    for (const channel of weighted) {
      let sum = 0;
      for (let i = start; i < start + blockSize; i++) sum += channel[i] * channel[i];
      power += sum / blockSize;
    }
    powers.push(power);
  }

  const aboveAbsolute = powers.filter(p => blockLoudness(p) > -70);
  if (!aboveAbsolute.length) return -Infinity;
  const relativeGate = blockLoudness(mean(aboveAbsolute)) - 10;
  return blockLoudness(mean(aboveAbsolute.filter(p => blockLoudness(p) > relativeGate)));
}
