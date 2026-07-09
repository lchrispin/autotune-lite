const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

function midiToNoteName(midiFloat) {
  const midi = Math.round(midiFloat);
  const name = NOTE_NAMES[((midi % 12) + 12) % 12];
  const octave = Math.floor(midi / 12) - 1;
  return `${name}${octave}`;
}

const startButton = document.getElementById('startButton');
const statusEl = document.getElementById('status');
const detectedEl = document.getElementById('detected');
const targetEl = document.getElementById('target');
const keySelect = document.getElementById('key');
const scaleSelect = document.getElementById('scale');
const strengthSlider = document.getElementById('strength');
const mixSlider = document.getElementById('mix');
const strengthValue = document.getElementById('strengthValue');
const mixValue = document.getElementById('mixValue');
const retuneSlider = document.getElementById('retune');
const retuneValue = document.getElementById('retuneValue');
const tunerNeedle = document.getElementById('tunerNeedle');
const bypassCheckbox = document.getElementById('bypass');
const monitorCheckbox = document.getElementById('monitor');
const recordButton = document.getElementById('recordButton');
const playback = document.getElementById('playback');
const playbackLabel = document.getElementById('playbackLabel');
const playbackAudio = document.getElementById('playbackAudio');
const downloadLink = document.getElementById('downloadLink');
const retuneButton = document.getElementById('retuneButton');
const fileInput = document.getElementById('fileInput');
const detectKeyButton = document.getElementById('detectKeyButton');
const guidanceEl = document.getElementById('guidance');
const presetButtons = document.querySelectorAll('.preset');

const STORAGE_KEY = 'autotune-lite-settings';

function loadSettings() {
  let saved;
  try {
    saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
  } catch {
    saved = {};
  }
  if (saved.key !== undefined) keySelect.value = saved.key;
  if (saved.scale !== undefined) scaleSelect.value = saved.scale;
  if (saved.strength !== undefined) strengthSlider.value = saved.strength;
  if (saved.mix !== undefined) mixSlider.value = saved.mix;
  if (saved.retune !== undefined) retuneSlider.value = saved.retune;
  if (saved.bypass !== undefined) bypassCheckbox.checked = saved.bypass;
  if (saved.monitor !== undefined) monitorCheckbox.checked = saved.monitor;
}

function saveSettings() {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        key: keySelect.value,
        scale: scaleSelect.value,
        strength: strengthSlider.value,
        mix: mixSlider.value,
        retune: retuneSlider.value,
        bypass: bypassCheckbox.checked,
        monitor: monitorCheckbox.checked,
      })
    );
  } catch {
    // Storage may be unavailable (private mode, disabled) — ignore.
  }
}
const canvas = document.getElementById('visualizer');
const canvasCtx = canvas.getContext('2d');

let audioContext = null;
let mediaStream = null;
let pitchNode = null;
let analyser = null;
let dryGain = null;
let wetGain = null;
let dryDelay = null;
let compressor = null;
let monitorGain = null;
let animationFrameId = null;
let running = false;

let recordDest = null;
let mediaRecorder = null;
let recordedChunks = [];
let recordedUrl = null;

// Raw (dry) capture kept alongside the corrected take, so a performance can be
// re-tuned offline with different key/scale/strength settings.
let rawDest = null;
let rawRecorder = null;
let rawChunks = [];
let rawBlob = null;
let retunedUrl = null;
let sourceUrl = null; // object URL for the current take/upload shown in the player

let detecting = false;
let keyHistogram = new Array(12).fill(0);
let detectTimer = null;

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = canvas.clientWidth * dpr;
  canvas.height = canvas.clientHeight * dpr;
  canvasCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener('resize', resizeCanvas);

function drawVisualizer() {
  animationFrameId = requestAnimationFrame(drawVisualizer);
  if (!analyser) return;

  const bufferLength = analyser.fftSize;
  const dataArray = new Uint8Array(bufferLength);
  analyser.getByteTimeDomainData(dataArray);

  const width = canvas.clientWidth;
  const height = canvas.clientHeight;

  canvasCtx.clearRect(0, 0, width, height);
  canvasCtx.lineWidth = 2;
  canvasCtx.strokeStyle = '#7dd3fc';
  canvasCtx.beginPath();

  const sliceWidth = width / bufferLength;
  let x = 0;
  for (let i = 0; i < bufferLength; i++) {
    const v = dataArray[i] / 128.0;
    const y = (v * height) / 2;
    if (i === 0) canvasCtx.moveTo(x, y);
    else canvasCtx.lineTo(x, y);
    x += sliceWidth;
  }
  canvasCtx.lineTo(width, height / 2);
  canvasCtx.stroke();
}

function sendParams() {
  if (!pitchNode) return;
  pitchNode.port.postMessage({
    type: 'params',
    root: Number(keySelect.value),
    scale: scaleSelect.value,
    strength: Number(strengthSlider.value) / 100,
    retuneSpeed: Number(retuneSlider.value) / 100,
    enabled: true,
  });
}

// Total processing delay of the PSOLA worklet, in samples: its grain-source
// latency (1024) plus the synthesis look-ahead (max pitch period + 128).
// Mirrors LATENCY/AHEAD in pitch-processor.js — keep the two in sync.
function workletLatencySamples(sr) {
  return 1024 + Math.ceil(sr / 80) + 128;
}

// Shared "vocal polish" chain: a gentle high-pass to cut mic rumble and
// plosive thumps, and light compression to even out levels (we ask the
// browser not to auto-gain) with a touch of makeup gain. Used identically in
// the live graph and the offline re-tune render so both sound the same.
function createHighpass(ctx) {
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 70;
  hp.Q.value = 0.707;
  return hp;
}

function createPolishChain(ctx) {
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -24;
  comp.knee.value = 24;
  comp.ratio.value = 3;
  comp.attack.value = 0.003;
  comp.release.value = 0.25;
  const makeup = ctx.createGain();
  makeup.gain.value = 1.25;
  comp.connect(makeup);
  return { input: comp, output: makeup };
}

async function start() {
  // Guard against re-entrancy (e.g. a fast second click) during async setup.
  startButton.disabled = true;
  statusEl.textContent = 'Requesting microphone access…';

  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        // Speech-call DSP audibly degrades singing — echo cancellation and
        // noise suppression gate note tails and dull the highs, and auto gain
        // pumps sustained notes. Ask for the raw feed; headphones (which the
        // UI already tells the user to wear) take care of feedback.
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
      },
    });

    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    // Browsers may start the context suspended until a user gesture resumes it.
    if (audioContext.state === 'suspended') await audioContext.resume();
    await audioContext.audioWorklet.addModule('pitch-processor.js');
  } catch (err) {
    statusEl.textContent = `Could not start audio: ${err.message}`;
    stop();
    startButton.disabled = false;
    return;
  }

  const source = audioContext.createMediaStreamSource(mediaStream);
  const highpass = createHighpass(audioContext);
  source.connect(highpass);

  pitchNode = new AudioWorkletNode(audioContext, 'pitch-processor', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
  });

  dryGain = audioContext.createGain();
  wetGain = audioContext.createGain();
  // Delay the dry path to match the worklet's processing latency, so blending
  // wet and dry sounds like a doubled voice instead of a slapback echo.
  dryDelay = audioContext.createDelay(0.25);
  dryDelay.delayTime.value = workletLatencySamples(audioContext.sampleRate) / audioContext.sampleRate;
  analyser = audioContext.createAnalyser();
  analyser.fftSize = 2048;

  highpass.connect(dryDelay);
  dryDelay.connect(dryGain);
  highpass.connect(pitchNode);
  pitchNode.connect(wetGain);

  const polish = createPolishChain(audioContext);
  compressor = polish.input;
  dryGain.connect(polish.input);
  wetGain.connect(polish.input);
  polish.output.connect(analyser);
  // Speaker output goes through a mutable monitor gain, so the mic can be used
  // without headphones (no feedback) while everything upstream — tuner,
  // visualizer, recording — keeps running on the full corrected signal.
  monitorGain = audioContext.createGain();
  analyser.connect(monitorGain);
  monitorGain.connect(audioContext.destination);

  // Tap the corrected mix upstream of the monitor gain so recordings capture
  // the tuned voice even when the speakers are muted.
  recordDest = audioContext.createMediaStreamDestination();
  analyser.connect(recordDest);

  // Also tap the uncorrected mic so a take can be re-tuned offline later.
  rawDest = audioContext.createMediaStreamDestination();
  highpass.connect(rawDest);

  updateMix();
  updateMonitor();

  pitchNode.port.onmessage = (event) => {
    const msg = event.data;
    if (msg.type === 'pitch') {
      detectedEl.textContent = `Detected: ${midiToNoteName(msg.detectedMidi)} (${msg.detectedFreq.toFixed(1)} Hz)`;
      targetEl.textContent = `Target: ${midiToNoteName(msg.targetMidi)} (${msg.targetFreq.toFixed(1)} Hz)`;
      updateTuner(msg.detectedFreq, msg.targetFreq);
      if (detecting) {
        const pc = ((Math.round(msg.detectedMidi) % 12) + 12) % 12;
        keyHistogram[pc]++;
      }
    } else if (msg.type === 'silence') {
      detectedEl.textContent = 'Detected: —';
      targetEl.textContent = 'Target: —';
      updateTuner(null, null);
    }
  };

  sendParams();

  running = true;
  statusEl.textContent = 'Listening — sing into the mic. Use headphones to avoid feedback.';
  startButton.textContent = 'Stop';
  startButton.disabled = false;
  recordButton.disabled = false;
  detectKeyButton.disabled = false;
  resizeCanvas();
  drawVisualizer();
}

function pickRecordingMime() {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
  if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return '';
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) || '';
}

function startRecording() {
  if (!recordDest || (mediaRecorder && mediaRecorder.state === 'recording')) return;

  const mimeType = pickRecordingMime();
  let recorder;
  try {
    recorder = new MediaRecorder(recordDest.stream, mimeType ? { mimeType } : undefined);
  } catch (err) {
    statusEl.textContent = `Recording unavailable: ${err.message}`;
    return;
  }
  mediaRecorder = recorder;

  recordedChunks = [];
  recorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) recordedChunks.push(event.data);
  };
  recorder.onstop = () => {
    const type = recorder.mimeType || mimeType || 'audio/webm';
    const blob = new Blob(recordedChunks, { type });
    if (recordedUrl) URL.revokeObjectURL(recordedUrl);
    recordedUrl = URL.createObjectURL(blob);
    playbackLabel.textContent = 'Last recording';
    playbackAudio.src = recordedUrl;
    downloadLink.href = recordedUrl;
    downloadLink.download = `autotune-recording.${type.includes('mp4') ? 'mp4' : type.includes('ogg') ? 'ogg' : 'webm'}`;
    playback.classList.remove('hidden');
  };

  // Capture the raw (dry) mic in parallel for offline re-tuning.
  rawChunks = [];
  try {
    rawRecorder = new MediaRecorder(rawDest.stream, mimeType ? { mimeType } : undefined);
    const raw = rawRecorder;
    raw.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) rawChunks.push(event.data);
    };
    raw.onstop = () => {
      rawBlob = new Blob(rawChunks, { type: raw.mimeType || mimeType || 'audio/webm' });
      retuneButton.disabled = false;
    };
    raw.start();
  } catch {
    rawRecorder = null; // re-tune simply stays unavailable if this fails
  }

  recorder.start();
  recordButton.textContent = '■ Stop Recording';
  recordButton.classList.add('recording');
  statusEl.textContent = 'Recording… sing your take.';
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
  if (rawRecorder && rawRecorder.state !== 'inactive') rawRecorder.stop();
  mediaRecorder = null;
  rawRecorder = null;
  recordButton.textContent = '● Record';
  recordButton.classList.remove('recording');
}

function toggleRecord() {
  if (mediaRecorder && mediaRecorder.state === 'recording') stopRecording();
  else startRecording();
}

// Load an audio file as the re-tune source, so a performance can be re-tuned
// even if it wasn't recorded here. An uploaded File is a Blob, so retune()
// consumes it exactly like a live take.
function handleFileUpload(event) {
  const file = event.target.files && event.target.files[0];
  if (!file) return;

  rawBlob = file;
  if (sourceUrl) URL.revokeObjectURL(sourceUrl);
  sourceUrl = URL.createObjectURL(file);
  playbackAudio.src = sourceUrl;
  downloadLink.href = sourceUrl;
  downloadLink.download = file.name;
  playbackLabel.textContent = `Uploaded — ${file.name}`;
  playback.classList.remove('hidden');
  retuneButton.disabled = false;
  statusEl.textContent = 'File loaded. Pick a key/scale/strength, then click Re-tune.';
}

// Render mono samples to a 16-bit PCM WAV blob (OfflineAudioContext hands
// back raw samples, so we encode them ourselves — no dependencies).
function samplesToWav(samples, sr) {
  const n = samples.length;
  const dataSize = n * 2;
  const ab = new ArrayBuffer(44 + dataSize);
  const view = new DataView(ab);
  const writeStr = (off, s) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sr, true);
  view.setUint32(28, sr * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);
  let off = 44;
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    off += 2;
  }
  return new Blob([ab], { type: 'audio/wav' });
}

// Re-run the raw take through the pitch worklet offline with the *current*
// key/scale/strength, so a performance can be re-tuned without re-singing.
async function retune() {
  if (!rawBlob) return;
  retuneButton.disabled = true;
  const label = retuneButton.textContent;
  retuneButton.textContent = 'Re-tuning…';
  let decodeCtx = null;
  try {
    const arrayBuf = await rawBlob.arrayBuffer();
    decodeCtx = new (window.AudioContext || window.webkitAudioContext)();
    const audioBuffer = await decodeCtx.decodeAudioData(arrayBuf);

    // Render extra samples to cover the worklet's processing latency, then
    // trim them off the front — the retuned take lines up with the original
    // and keeps its full tail instead of starting with a gap.
    const latencySamples = workletLatencySamples(audioBuffer.sampleRate);
    const offline = new OfflineAudioContext(
      1,
      audioBuffer.length + latencySamples,
      audioBuffer.sampleRate
    );
    await offline.audioWorklet.addModule('pitch-processor.js');
    const srcNode = offline.createBufferSource();
    srcNode.buffer = audioBuffer;
    const node = new AudioWorkletNode(offline, 'pitch-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    node.port.postMessage({
      type: 'params',
      root: Number(keySelect.value),
      scale: scaleSelect.value,
      strength: Number(strengthSlider.value) / 100,
      retuneSpeed: Number(retuneSlider.value) / 100,
      enabled: true,
    });
    // Same high-pass + polish chain as the live graph, so an offline re-tune
    // sounds like what the user heard while singing.
    const highpass = createHighpass(offline);
    const polish = createPolishChain(offline);
    srcNode.connect(highpass);
    highpass.connect(node);
    node.connect(polish.input);
    polish.output.connect(offline.destination);
    srcNode.start();

    const rendered = await offline.startRendering();
    const wavBlob = samplesToWav(rendered.getChannelData(0).subarray(latencySamples), rendered.sampleRate);
    if (retunedUrl) URL.revokeObjectURL(retunedUrl);
    retunedUrl = URL.createObjectURL(wavBlob);
    playbackAudio.src = retunedUrl;
    downloadLink.href = retunedUrl;
    downloadLink.download = 'autotune-retuned.wav';
    const keyName = NOTE_NAMES[Number(keySelect.value)];
    playbackLabel.textContent = `Re-tuned — ${keyName} ${scaleSelect.value}`;
    playback.classList.remove('hidden');
  } catch (err) {
    statusEl.textContent = `Re-tune failed: ${err.message}`;
  } finally {
    if (decodeCtx) decodeCtx.close();
    retuneButton.textContent = label;
    retuneButton.disabled = false;
  }
}

function stop() {
  running = false;
  stopRecording();
  recordButton.disabled = true;
  detectKeyButton.disabled = true;
  if (detectTimer) {
    clearTimeout(detectTimer);
    detectTimer = null;
  }
  detecting = false;
  detectKeyButton.textContent = 'Detect Key';
  recordDest = null;
  rawDest = null;
  if (animationFrameId) cancelAnimationFrame(animationFrameId);
  if (mediaStream) {
    mediaStream.getTracks().forEach((track) => track.stop());
    mediaStream = null;
  }
  if (audioContext) {
    audioContext.close();
    audioContext = null;
  }
  pitchNode = null;
  analyser = null;
  dryDelay = null;
  compressor = null;
  monitorGain = null;
  canvasCtx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
  statusEl.textContent = 'Stopped.';
  detectedEl.textContent = 'Detected: —';
  targetEl.textContent = 'Target: —';
  startButton.textContent = 'Start';
  startButton.disabled = false;
}

function updateMix() {
  mixValue.textContent = `${mixSlider.value}%`;
  if (!dryGain || !wetGain) return;
  // Bypass forces the raw (dry) signal through regardless of the mix slider.
  const mix = bypassCheckbox.checked ? 0 : Number(mixSlider.value) / 100;
  dryGain.gain.value = 1 - mix;
  wetGain.gain.value = mix;
}

function updateMonitor() {
  if (!monitorGain || !audioContext) return;
  // Short ramp instead of a hard switch so toggling doesn't click.
  const target = monitorCheckbox.checked ? 1 : 0;
  monitorGain.gain.setTargetAtTime(target, audioContext.currentTime, 0.01);
}

function updateStrengthLabel() {
  strengthValue.textContent = `${strengthSlider.value}%`;
}

function updateRetuneLabel() {
  retuneValue.textContent = `${retuneSlider.value}%`;
}

// Move the tuning-meter needle to show how far the detected pitch sits from the
// target note, in cents (clamped to +/-50). Green when essentially in tune.
function updateTuner(detectedFreq, targetFreq) {
  if (!detectedFreq || !targetFreq) {
    tunerNeedle.style.left = '50%';
    tunerNeedle.style.opacity = '0.35';
    tunerNeedle.classList.remove('in-tune');
    return;
  }
  let cents = 1200 * Math.log2(detectedFreq / targetFreq);
  cents = Math.max(-50, Math.min(50, cents));
  tunerNeedle.style.left = `${50 + cents}%`;
  tunerNeedle.style.opacity = '1';
  tunerNeedle.classList.toggle('in-tune', Math.abs(cents) < 8);
}

// --- Presets: one-click sensible combinations of strength + mix ---
const PRESETS = {
  subtle: { strength: 40, mix: 90, retune: 30 },
  pop: { strength: 75, mix: 100, retune: 60 },
  hard: { strength: 100, mix: 100, retune: 100 },
};

function applyPreset(name) {
  const preset = PRESETS[name];
  if (!preset) return;
  strengthSlider.value = preset.strength;
  mixSlider.value = preset.mix;
  retuneSlider.value = preset.retune;
  bypassCheckbox.checked = false;
  updateStrengthLabel();
  updateRetuneLabel();
  updateMix();
  sendParams();
  saveSettings();
  markActivePreset(name);
  updateGuidance();
}

function markActivePreset(name) {
  presetButtons.forEach((btn) => btn.classList.toggle('active', btn.dataset.preset === name));
}

// Clear the active-preset highlight when the user hand-tweaks the sliders.
function clearActivePreset() {
  presetButtons.forEach((btn) => btn.classList.remove('active'));
}

// --- Plain-language description of the current effect ---
function updateGuidance() {
  const strength = Number(strengthSlider.value);
  const scale = scaleSelect.value;
  const scaleText =
    scale === 'chromatic'
      ? 'snapping to the nearest semitone (any key)'
      : `snapping into ${NOTE_NAMES[Number(keySelect.value)]} ${scale}`;

  let amount;
  if (bypassCheckbox.checked) amount = 'Bypassed — you hear your raw voice.';
  else if (strength < 20) amount = 'Barely correcting — nearly your natural voice.';
  else if (strength < 60) amount = `Gentle, natural tuning, ${scaleText}.`;
  else if (strength < 95) amount = `Strong tuning, ${scaleText}.`;
  else
    amount =
      scale === 'chromatic'
        ? `Hard robotic snap (T-Pain style), ${scaleText}.`
        : `Hard snap, ${scaleText}.`;
  if (!monitorCheckbox.checked) {
    amount += ' Speakers muted — you won’t hear yourself, but recordings still capture the tuned voice.';
  }
  guidanceEl.textContent = amount;
}

// --- Detect the key/scale from what the user is singing (Krumhansl-Schmuckler) ---
const KRUMHANSL_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const KRUMHANSL_MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

function correlate(a, b) {
  const n = a.length;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    ma += a[i];
    mb += b[i];
  }
  ma /= n;
  mb /= n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma;
    const y = b[i] - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  return da && db ? num / Math.sqrt(da * db) : -1;
}

function detectKeyFromHistogram(hist) {
  let total = 0;
  for (const v of hist) total += v;
  if (total < 8) return null; // too little pitched audio to be confident
  let best = { score: -Infinity };
  for (let root = 0; root < 12; root++) {
    const maj = KRUMHANSL_MAJOR.map((_, i) => KRUMHANSL_MAJOR[(i - root + 12) % 12]);
    const min = KRUMHANSL_MINOR.map((_, i) => KRUMHANSL_MINOR[(i - root + 12) % 12]);
    const sMaj = correlate(hist, maj);
    const sMin = correlate(hist, min);
    if (sMaj > best.score) best = { score: sMaj, root, scale: 'major' };
    if (sMin > best.score) best = { score: sMin, root, scale: 'minor' };
  }
  return best;
}

function startDetectKey() {
  if (!running || detecting) return;
  detecting = true;
  keyHistogram = new Array(12).fill(0);
  detectKeyButton.disabled = true;
  detectKeyButton.textContent = 'Listening…';
  statusEl.textContent = 'Listening for your key — sing a few notes…';
  detectTimer = setTimeout(finishDetectKey, 6000);
}

function finishDetectKey() {
  detecting = false;
  detectTimer = null;
  detectKeyButton.textContent = 'Detect Key';
  detectKeyButton.disabled = !running;

  const result = detectKeyFromHistogram(keyHistogram);
  if (!result) {
    statusEl.textContent = 'Could not detect a key — sing a bit louder and try again.';
    return;
  }
  keySelect.value = String(result.root);
  scaleSelect.value = result.scale;
  sendParams();
  saveSettings();
  updateGuidance();
  statusEl.textContent = `Detected key: ${NOTE_NAMES[result.root]} ${result.scale}.`;
}

startButton.addEventListener('click', () => {
  if (running) stop();
  else start();
});

recordButton.addEventListener('click', toggleRecord);
detectKeyButton.addEventListener('click', startDetectKey);
presetButtons.forEach((btn) => btn.addEventListener('click', () => applyPreset(btn.dataset.preset)));
retuneButton.addEventListener('click', retune);
fileInput.addEventListener('change', handleFileUpload);

keySelect.addEventListener('change', () => {
  sendParams();
  saveSettings();
  updateGuidance();
});
scaleSelect.addEventListener('change', () => {
  sendParams();
  saveSettings();
  updateGuidance();
});
strengthSlider.addEventListener('input', () => {
  updateStrengthLabel();
  sendParams();
  saveSettings();
  clearActivePreset();
  updateGuidance();
});
retuneSlider.addEventListener('input', () => {
  updateRetuneLabel();
  sendParams();
  saveSettings();
  clearActivePreset();
});
mixSlider.addEventListener('input', () => {
  updateMix();
  saveSettings();
  clearActivePreset();
});
bypassCheckbox.addEventListener('change', () => {
  updateMix();
  saveSettings();
  updateGuidance();
});
monitorCheckbox.addEventListener('change', () => {
  updateMonitor();
  saveSettings();
  updateGuidance();
});

loadSettings();
updateStrengthLabel();
updateRetuneLabel();
updateMix();
updateGuidance();
resizeCanvas();
