// AudioWorkletProcessor that detects the singer's pitch, snaps it to the
// nearest note in a chosen key/scale, and pitch-shifts the live signal
// toward that note using a simple granular (overlap-add) resampler.
//
// This is intentionally a lightweight approximation of "real" Auto-Tune
// (which uses PSOLA/formant-aware shifting). Good enough for a fun demo,
// not meant for studio-quality vocal production.

const SCALES = {
  chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
};

const RING_SIZE = 1 << 15; // ~0.7s of lookback at 48kHz, plenty for grains + analysis
const GRAIN_LEN = 2048; // ~43-46ms grain, 50% overlap
const HOP = GRAIN_LEN / 2;
const ANALYSIS_WINDOW = 2048;
const ANALYSIS_HOP = 1024;
const MIN_FREQ = 80; // Hz, autocorrelation search floor
const MAX_FREQ = 1000; // Hz, autocorrelation search ceiling
const SILENCE_RMS = 0.01;
const CLARITY_THRESHOLD = 0.5; // min normalized correlation to accept a pitch
const PEAK_PICK_RATIO = 0.9; // accept first NSDF peak >= this fraction of the max
const RATIO_MIN = 0.5;
const RATIO_MAX = 2.0;
const RATIO_SMOOTHING = 0.25; // per-block lerp toward target ratio

function hann(x) {
  // x in [0, 1)
  return 0.5 - 0.5 * Math.cos(2 * Math.PI * x);
}

function freqToMidi(f) {
  return 69 + 12 * Math.log2(f / 440);
}

function midiToFreq(m) {
  return 440 * Math.pow(2, (m - 69) / 12);
}

function snapMidiToScale(midiFloat, rootPc, scaleIntervals) {
  const midiRound = Math.round(midiFloat);
  const pc = (((midiRound - rootPc) % 12) + 12) % 12;
  let best = scaleIntervals[0];
  let bestDist = Infinity;
  for (const iv of scaleIntervals) {
    const d = Math.min(Math.abs(pc - iv), 12 - Math.abs(pc - iv));
    if (d < bestDist) {
      bestDist = d;
      best = iv;
    }
  }
  let diff = best - pc;
  if (diff > 6) diff -= 12;
  if (diff < -6) diff += 12;
  return midiRound + diff;
}

class PitchProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    this.ring = new Float32Array(RING_SIZE);
    this.writeIndex = 0;

    this.analysisBuf = new Float32Array(ANALYSIS_WINDOW);
    this.nsdf = new Float32Array(ANALYSIS_WINDOW); // scratch for pitch detection
    this.samplesSinceAnalysis = 0;

    this.grains = [
      { age: 0, basePos: 0 },
      { age: HOP, basePos: 0 },
    ];

    this.currentRatio = 1;
    this.targetRatio = 1;

    this.enabled = true;
    this.rootPc = 0; // C
    this.scaleIntervals = SCALES.chromatic;
    this.strength = 1; // 0..1, how strongly to pull toward the snapped note

    this.msgCounter = 0;

    this.port.onmessage = (event) => {
      const msg = event.data;
      if (msg.type === 'params') {
        if (typeof msg.root === 'number') this.rootPc = ((msg.root % 12) + 12) % 12;
        if (msg.scale && SCALES[msg.scale]) this.scaleIntervals = SCALES[msg.scale];
        if (typeof msg.strength === 'number') this.strength = Math.min(1, Math.max(0, msg.strength));
        if (typeof msg.enabled === 'boolean') this.enabled = msg.enabled;
      }
    };
  }

  detectPitch(buf) {
    const size = buf.length;
    let sumSq = 0;
    for (let i = 0; i < size; i++) sumSq += buf[i] * buf[i];
    const rms = Math.sqrt(sumSq / size);
    if (rms < SILENCE_RMS) return -1;

    const minLag = Math.max(2, Math.floor(sampleRate / MAX_FREQ));
    const maxLag = Math.min(size - 1, Math.floor(sampleRate / MIN_FREQ));

    // Normalized square-difference function (NSDF, McLeod). Dividing by the
    // local energy keeps each score in [-1, 1] and removes the short-lag bias
    // of raw autocorrelation.
    const nsdf = this.nsdf;
    let maxScore = 0;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let corr = 0;
      let energy = 0;
      const limit = size - lag;
      for (let i = 0; i < limit; i++) {
        const a = buf[i];
        const b = buf[i + lag];
        corr += a * b;
        energy += a * a + b * b;
      }
      const score = energy > 0 ? (2 * corr) / energy : 0;
      nsdf[lag] = score;
      if (score > maxScore) maxScore = score;
    }

    // Reject weak/noisy peaks: a real pitched note correlates strongly with
    // itself one period later, so a low peak means "no clear pitch".
    if (maxScore < CLARITY_THRESHOLD) return -1;

    // Peak-pick the *first* local maximum that clears a fraction of the tallest
    // peak. Choosing the earliest (shortest-period) qualifying peak — rather
    // than the global max — avoids sub-octave errors, since a clean tone peaks
    // near 1.0 at every multiple of its true period.
    const threshold = PEAK_PICK_RATIO * maxScore;
    let bestLag = -1;
    for (let lag = minLag + 1; lag < maxLag; lag++) {
      if (nsdf[lag] >= threshold && nsdf[lag] > nsdf[lag - 1] && nsdf[lag] >= nsdf[lag + 1]) {
        bestLag = lag;
        break;
      }
    }
    if (bestLag < 0) return -1;

    // Parabolic interpolation over the NSDF around the chosen peak for a
    // sub-sample lag estimate.
    let refinedLag = bestLag;
    const cPrev = nsdf[bestLag - 1];
    const cCurr = nsdf[bestLag];
    const cNext = nsdf[bestLag + 1];
    const denom = cPrev - 2 * cCurr + cNext;
    if (denom !== 0) {
      const shift = (0.5 * (cPrev - cNext)) / denom;
      if (Math.abs(shift) < 1) refinedLag = bestLag + shift;
    }

    if (refinedLag <= 0) return -1;
    return sampleRate / refinedLag;
  }

  runAnalysis() {
    // Copy the most recent ANALYSIS_WINDOW samples out of the ring buffer.
    const start = this.writeIndex - ANALYSIS_WINDOW;
    for (let i = 0; i < ANALYSIS_WINDOW; i++) {
      const idx = (((start + i) % RING_SIZE) + RING_SIZE) % RING_SIZE;
      this.analysisBuf[i] = this.ring[idx];
    }

    const f0 = this.detectPitch(this.analysisBuf);

    if (f0 > 0 && this.enabled) {
      const midi = freqToMidi(f0);
      const snappedMidi = snapMidiToScale(midi, this.rootPc, this.scaleIntervals);
      const targetFreq = midiToFreq(snappedMidi);
      let idealRatio = targetFreq / f0;
      idealRatio = Math.min(RATIO_MAX, Math.max(RATIO_MIN, idealRatio));
      this.targetRatio = 1 + this.strength * (idealRatio - 1);

      this.msgCounter++;
      if (this.msgCounter % 3 === 0) {
        this.port.postMessage({
          type: 'pitch',
          detectedFreq: f0,
          detectedMidi: midi,
          targetMidi: snappedMidi,
          targetFreq,
        });
      }
    } else {
      this.targetRatio = 1;
      this.msgCounter++;
      if (this.msgCounter % 3 === 0) {
        this.port.postMessage({ type: 'silence' });
      }
    }
  }

  readRing(pos) {
    // Linear interpolation between the two nearest integer ring positions.
    const p0 = Math.floor(pos);
    const frac = pos - p0;
    const i0 = (((p0 % RING_SIZE) + RING_SIZE) % RING_SIZE);
    const i1 = (i0 + 1) % RING_SIZE;
    return this.ring[i0] * (1 - frac) + this.ring[i1] * frac;
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || input.length === 0 || !output || output.length === 0) {
      return true;
    }

    const inCh = input[0];
    const outCh = output[0];
    const blockSize = outCh.length;

    // Smooth the ratio once per block to avoid per-sample jitter cost.
    this.currentRatio += (this.targetRatio - this.currentRatio) * RATIO_SMOOTHING;
    const ratio = this.enabled ? this.currentRatio : 1;

    for (let i = 0; i < blockSize; i++) {
      const sample = inCh && inCh.length > 0 ? inCh[i] : 0;
      this.ring[this.writeIndex % RING_SIZE] = sample;
      this.writeIndex++;

      let out = 0;
      for (const grain of this.grains) {
        const readPos = grain.basePos + grain.age * ratio;
        const w = hann(grain.age / GRAIN_LEN);
        out += this.readRing(readPos) * w;
        grain.age++;
        if (grain.age >= GRAIN_LEN) {
          grain.age = 0;
          grain.basePos = this.writeIndex - GRAIN_LEN;
        }
      }

      outCh[i] = out;

      this.samplesSinceAnalysis++;
      if (this.samplesSinceAnalysis >= ANALYSIS_HOP && this.writeIndex >= ANALYSIS_WINDOW) {
        this.samplesSinceAnalysis = 0;
        this.runAnalysis();
      }
    }

    return true;
  }
}

registerProcessor('pitch-processor', PitchProcessor);
