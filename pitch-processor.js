// AudioWorkletProcessor that detects the singer's pitch, snaps it to the
// nearest note in a chosen key/scale, and pitch-shifts the live signal onto
// that note using time-domain PSOLA (pitch-synchronous overlap-add).
//
// PSOLA extracts two-period, Hann-windowed grains centred on a period-locked
// analysis grid and overlap-adds them at the *target* period. Because adjacent
// grains are exactly one pitch period apart, they overlap in phase instead of
// cancelling — so the full correction is applied cleanly (the note actually
// lands on target) with little of the warble a fixed-grain resampler produces.

const SCALES = {
  chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
};

const RING_SIZE = 1 << 15; // ~0.7s of input lookback at 48kHz
const OUTBUF_LEN = 1 << 13; // overlap-add accumulator, ample for grains + latency
const ANALYSIS_WINDOW = 2048;
const ANALYSIS_HOP = 1024;
const MIN_FREQ = 80; // Hz, autocorrelation search floor
const MAX_FREQ = 1100; // Hz, autocorrelation search ceiling (covers soprano C6)
const SILENCE_RMS = 0.003; // raw mic capture (no auto-gain) sits well below speech-call levels
const HYSTERESIS_SEMITONES = 0.3; // how much closer a new note must be before the target switches
const CLARITY_THRESHOLD = 0.5; // min normalized correlation to accept a pitch
const PEAK_PICK_RATIO = 0.9; // accept first NSDF peak >= this fraction of the max
const RATIO_MIN = 0.5; // clamp the shift ratio to +/- one octave
const RATIO_MAX = 2.0;

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

    // Period bounds (in samples) and buffering delays, derived from the graph's
    // sample rate. LATENCY is how far behind the write head grains are sourced;
    // AHEAD keeps the read pointer safely behind the synthesis frontier so every
    // output sample has received all of its overlapping grains before it's read.
    this.minPeriod = Math.max(2, Math.floor(sampleRate / MAX_FREQ));
    this.maxPeriod = Math.ceil(sampleRate / MIN_FREQ);
    this.latency = 1024;
    this.ahead = this.maxPeriod + 128;

    // Overlap-add synthesis buffers (normalized: out = Σ(x·w) / Σ(w)).
    this.outBuf = new Float32Array(OUTBUF_LEN);
    this.normBuf = new Float32Array(OUTBUF_LEN);
    this.outRead = 0; // absolute index of the next output sample
    this.synthCenter = 0; // absolute output index for the next grain centre
    this.analysisMark = 0; // absolute input index of the current analysis epoch
    this.inited = false;

    this.period = sampleRate / 200; // sensible default until the first detection
    this.voiced = false;
    this.fadeGain = 0; // short ramp-in so the first grains don't tick on start

    this.currentRatio = 1;
    this.targetRatio = 1;

    // Pitch-track conditioning: recent f0 estimates for median filtering, the
    // currently held target note for snap hysteresis, and how many analysis
    // frames in a row have been unvoiced (short dropouts keep the held note).
    this.f0History = [];
    this.heldMidi = null;
    this.unvoicedRun = 0;

    this.enabled = true;
    this.rootPc = 0; // C
    this.scaleIntervals = SCALES.chromatic;
    this.strength = 1; // 0..1, how strongly to pull toward the snapped note
    this.retuneAlpha = 0.3; // per-block lerp toward targetRatio (set by retuneSpeed)

    this.msgCounter = 0;

    this.port.onmessage = (event) => {
      const msg = event.data;
      if (msg.type === 'params') {
        if (typeof msg.root === 'number') this.rootPc = ((msg.root % 12) + 12) % 12;
        if (msg.scale && SCALES[msg.scale]) this.scaleIntervals = SCALES[msg.scale];
        if (typeof msg.strength === 'number') this.strength = Math.min(1, Math.max(0, msg.strength));
        if (typeof msg.enabled === 'boolean') this.enabled = msg.enabled;
        if (typeof msg.retuneSpeed === 'number') {
          // 0 = slow, natural glide; 1 = near-instant robotic snap. Squared so
          // the lower half of the slider gives fine control over gentle glides.
          const s = Math.min(1, Math.max(0, msg.retuneSpeed));
          this.retuneAlpha = 0.03 + s * s * 0.95;
        }
      }
    };
  }

  detectPitch(buf) {
    const size = buf.length;
    // Remove DC before correlating — a raw mic feed can carry offset/rumble
    // that inflates NSDF scores at every lag and produces false pitches.
    let sum = 0;
    for (let i = 0; i < size; i++) sum += buf[i];
    const mean = sum / size;
    let sumSq = 0;
    for (let i = 0; i < size; i++) {
      const centered = buf[i] - mean;
      buf[i] = centered;
      sumSq += centered * centered;
    }
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

    let f0 = this.detectPitch(this.analysisBuf);

    if (f0 > 0) {
      // Median-of-3 over recent estimates rejects single-frame octave/glitch
      // errors, which otherwise slew the ratio toward a wrong note and chirp.
      // A real note change still gets through on the second frame (~21ms).
      this.f0History.push(f0);
      if (this.f0History.length > 3) this.f0History.shift();
      if (this.f0History.length === 3) {
        const s = [this.f0History[0], this.f0History[1], this.f0History[2]].sort((a, b) => a - b);
        f0 = s[1];
      }
    }

    if (f0 > 0 && this.enabled) {
      const midi = freqToMidi(f0);
      let snappedMidi = snapMidiToScale(midi, this.rootPc, this.scaleIntervals);
      // Hysteresis: keep the held target note unless the detected pitch is
      // decisively closer to a different scale note. Without this the target
      // flickers between neighbours whenever the singer sits near the
      // boundary, which is audible as a rapid warble/trill.
      if (
        this.heldMidi !== null &&
        snappedMidi !== this.heldMidi &&
        Math.abs(midi - this.heldMidi) < Math.abs(midi - snappedMidi) + HYSTERESIS_SEMITONES
      ) {
        snappedMidi = this.heldMidi;
      }
      this.heldMidi = snappedMidi;
      this.unvoicedRun = 0;
      const targetFreq = midiToFreq(snappedMidi);
      let idealRatio = targetFreq / f0;
      idealRatio = Math.min(RATIO_MAX, Math.max(RATIO_MIN, idealRatio));
      // Blend in log-frequency space so "50% strength" closes half the
      // distance in cents — musically even whether shifting up or down.
      this.targetRatio = Math.pow(idealRatio, this.strength);
      this.period = Math.min(this.maxPeriod, Math.max(this.minPeriod, sampleRate / f0));
      this.voiced = true;

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
      // Unvoiced: aim for ratio 1. At ratio 1 the synthesis grid matches the
      // analysis grid, so PSOLA reconstructs the (delayed) input unchanged —
      // a clean passthrough with no special-casing. Keep the last period.
      this.targetRatio = 1;
      this.voiced = false;
      // Keep the held note through short dropouts (a breath, a consonant) so
      // the target doesn't have to be re-acquired mid-phrase; release it after
      // a few unvoiced frames so the next phrase starts fresh.
      this.unvoicedRun++;
      if (this.unvoicedRun > 3) {
        this.heldMidi = null;
        this.f0History.length = 0;
      }
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
    const i0 = ((p0 % RING_SIZE) + RING_SIZE) % RING_SIZE;
    const i1 = (i0 + 1) % RING_SIZE;
    return this.ring[i0] * (1 - frac) + this.ring[i1] * frac;
  }

  // Extract one Hann grain from the input at the current pitch-locked analysis
  // epoch and overlap-add it into the output accumulator at synthCenter.
  scheduleGrain() {
    const period = this.period;
    const half = Math.max(2, Math.round(period));
    const grainLen = 2 * half;

    // Slide the analysis epoch — in whole-period steps, so consecutive grains
    // stay phase-aligned — to the epoch nearest the point LATENCY behind the
    // write head. This tracks the live input while keeping pitch-synchrony.
    const target = this.writeIndex - this.latency;
    let mark = this.analysisMark;
    while (mark < target - period / 2) mark += period;
    while (mark > target + period / 2) mark -= period;
    this.analysisMark = mark;

    const center = Math.round(this.synthCenter);
    for (let k = 0; k < grainLen; k++) {
      const w = hann(k / grainLen);
      const sample = this.readRing(mark - half + k) * w;
      const dst = center - half + k;
      if (dst >= this.outRead) {
        const slot = ((dst % OUTBUF_LEN) + OUTBUF_LEN) % OUTBUF_LEN;
        this.outBuf[slot] += sample;
        this.normBuf[slot] += w;
      }
    }
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

    // Ease the shift ratio toward its target once per block. retuneAlpha (set by
    // the Retune Speed control) decides how hard the note snaps into place.
    this.currentRatio += (this.targetRatio - this.currentRatio) * this.retuneAlpha;

    for (let i = 0; i < blockSize; i++) {
      const sample = inCh && inCh.length > 0 ? inCh[i] : 0;
      this.ring[this.writeIndex % RING_SIZE] = sample;
      this.writeIndex++;

      if (!this.inited && this.writeIndex > this.latency + this.maxPeriod) {
        this.synthCenter = this.outRead + this.ahead;
        this.analysisMark = this.writeIndex - this.latency;
        this.inited = true;
      }

      let out = 0;
      if (this.inited) {
        // Schedule grains until the synthesis frontier is AHEAD of the read
        // pointer, so this output sample is fully formed. Synthesis grains are
        // spaced at the target period (input period / ratio); that spacing is
        // what shifts the pitch onto the snapped note.
        while (this.synthCenter <= this.outRead + this.ahead) {
          this.scheduleGrain();
          const ratio = this.enabled ? this.currentRatio : 1;
          this.synthCenter += this.period / ratio;
        }
        const slot = this.outRead % OUTBUF_LEN;
        const norm = this.normBuf[slot];
        out = norm > 1e-6 ? this.outBuf[slot] / norm : 0;
        this.outBuf[slot] = 0;
        this.normBuf[slot] = 0;

        if (this.fadeGain < 1) {
          this.fadeGain = Math.min(1, this.fadeGain + 1 / 4096);
          out *= this.fadeGain;
        }
      }

      outCh[i] = out;
      this.outRead++;

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
