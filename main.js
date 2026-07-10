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
const editNotesButton = document.getElementById('editNotesButton');
const noteEditor = document.getElementById('noteEditor');
const pianoRoll = document.getElementById('pianoRoll');
const rollCtx = pianoRoll.getContext('2d');
const noteInfoEl = document.getElementById('noteInfo');
const noteHintsEl = document.getElementById('noteHints');
const hintChipsEl = document.getElementById('hintChips');
const noteUpButton = document.getElementById('noteUpButton');
const noteDownButton = document.getElementById('noteDownButton');
const noteResetButton = document.getElementById('noteResetButton');
const noteResetAllButton = document.getElementById('noteResetAllButton');
const renderEditsButton = document.getElementById('renderEditsButton');

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
      editNotesButton.disabled = false;
      resetNoteEditor(); // a new take invalidates the previous note analysis
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
  editNotesButton.disabled = false;
  resetNoteEditor(); // a new source invalidates the previous note analysis
  statusEl.textContent = 'File loaded. Re-tune it, or click Edit Notes to move individual notes.';
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
// When a noteMap is given (from the note editor), those time regions are
// pinned to the user's chosen target notes instead of plain scale snapping.
async function retune(noteMap = null) {
  if (!rawBlob) return;
  const hasEdits = Boolean(noteMap && noteMap.length);
  const busyButton = hasEdits ? renderEditsButton : retuneButton;
  retuneButton.disabled = true;
  renderEditsButton.disabled = true;
  const label = busyButton.textContent;
  busyButton.textContent = 'Re-tuning…';
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
    // Settings must go through processorOptions here: an OfflineAudioContext
    // renders without servicing the worklet port's message queue, so a
    // postMessage would only arrive after rendering has already finished.
    const node = new AudioWorkletNode(offline, 'pitch-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: {
        root: Number(keySelect.value),
        scale: scaleSelect.value,
        strength: Number(strengthSlider.value) / 100,
        retuneSpeed: Number(retuneSlider.value) / 100,
        enabled: true,
        noteMap: hasEdits ? noteMap : null,
      },
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
    downloadLink.download = hasEdits ? 'autotune-note-edited.wav' : 'autotune-retuned.wav';
    const keyName = NOTE_NAMES[Number(keySelect.value)];
    playbackLabel.textContent = hasEdits
      ? `Re-tuned with ${noteMap.length} note edit${noteMap.length === 1 ? '' : 's'} — ${keyName} ${scaleSelect.value}`
      : `Re-tuned — ${keyName} ${scaleSelect.value}`;
    playback.classList.remove('hidden');
  } catch (err) {
    statusEl.textContent = `Re-tune failed: ${err.message}`;
  } finally {
    if (decodeCtx) decodeCtx.close();
    busyButton.textContent = label;
    retuneButton.disabled = false;
    renderEditsButton.disabled = false;
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

// =========================================================================
// Note editor: analyze the raw take into discrete sung notes, let the user
// move individual notes up or down (with scale-aware hints for where to go),
// then re-render the take with those notes pinned to the chosen pitches.
// =========================================================================

// Mirrors SCALES in pitch-processor.js — keep the two in sync.
const SCALES = {
  chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
};

function freqToMidi(f) {
  return 69 + 12 * Math.log2(f / 440);
}

function isInScale(midi) {
  const pc = (((midi - Number(keySelect.value)) % 12) + 12) % 12;
  return SCALES[scaleSelect.value].includes(pc);
}

// Nearest note of the current key/scale strictly above (dir=1) or below
// (dir=-1) the given note.
function nextScaleNote(midi, dir) {
  for (let m = midi + dir; Math.abs(m - midi) <= 12; m += dir) {
    if (isInScale(m)) return m;
  }
  return midi + dir;
}

function median(list) {
  const s = [...list].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// --- Offline pitch analysis (same NSDF detector as the worklet) ---

const EDIT_WINDOW = 2048;
const EDIT_HOP = 1024;
const EDIT_MIN_FREQ = 80;
const EDIT_MAX_FREQ = 1100;
const EDIT_SILENCE_RMS = 0.003;
const EDIT_CLARITY = 0.5;
const EDIT_PEAK_RATIO = 0.9;
const MIN_NOTE_FRAMES = 4; // ~85ms at 48kHz — anything shorter isn't a held note
const NOTE_SPLIT_SEMITONES = 0.8; // sustained drift beyond this starts a new note

function detectF0(data, start, sr, win, nsdf) {
  const size = EDIT_WINDOW;
  let sum = 0;
  for (let i = 0; i < size; i++) sum += data[start + i];
  const mean = sum / size;
  let sumSq = 0;
  for (let i = 0; i < size; i++) {
    const c = data[start + i] - mean;
    win[i] = c;
    sumSq += c * c;
  }
  if (Math.sqrt(sumSq / size) < EDIT_SILENCE_RMS) return -1;

  const minLag = Math.max(2, Math.floor(sr / EDIT_MAX_FREQ));
  const maxLag = Math.min(size - 1, Math.floor(sr / EDIT_MIN_FREQ));
  let maxScore = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let corr = 0;
    let energy = 0;
    const limit = size - lag;
    for (let i = 0; i < limit; i++) {
      const a = win[i];
      const b = win[i + lag];
      corr += a * b;
      energy += a * a + b * b;
    }
    const score = energy > 0 ? (2 * corr) / energy : 0;
    nsdf[lag] = score;
    if (score > maxScore) maxScore = score;
  }
  if (maxScore < EDIT_CLARITY) return -1;

  const threshold = EDIT_PEAK_RATIO * maxScore;
  let bestLag = -1;
  for (let lag = minLag + 1; lag < maxLag; lag++) {
    if (nsdf[lag] >= threshold && nsdf[lag] > nsdf[lag - 1] && nsdf[lag] >= nsdf[lag + 1]) {
      bestLag = lag;
      break;
    }
  }
  if (bestLag < 0) return -1;

  let refined = bestLag;
  const denom = nsdf[bestLag - 1] - 2 * nsdf[bestLag] + nsdf[bestLag + 1];
  if (denom !== 0) {
    const shift = (0.5 * (nsdf[bestLag - 1] - nsdf[bestLag + 1])) / denom;
    if (Math.abs(shift) < 1) refined = bestLag + shift;
  }
  return refined > 0 ? sr / refined : -1;
}

// Turn a decoded take into note segments: contiguous voiced frames whose
// pitch stays near the note's recent median. Returns
// [{ startSample, endSample, startTime, endTime, medianMidi, baseMidi,
//    targetMidi, mono, runLen }] sorted by time.
async function extractNoteSegments(buffer) {
  const data = buffer.getChannelData(0);
  const sr = buffer.sampleRate;
  const win = new Float32Array(EDIT_WINDOW);
  const nsdf = new Float32Array(EDIT_WINDOW);

  const midis = [];
  for (let start = 0; start + EDIT_WINDOW <= data.length; start += EDIT_HOP) {
    const f0 = detectF0(data, start, sr, win, nsdf);
    midis.push(f0 > 0 ? freqToMidi(f0) : null);
    // Yield to the event loop periodically so long takes don't freeze the UI.
    if (midis.length % 64 === 0) await new Promise((r) => setTimeout(r));
  }

  // Median-of-3 knocks out single-frame octave/glitch errors, mirroring the
  // conditioning the live engine applies to its pitch track.
  const track = midis.slice();
  for (let i = 1; i < midis.length - 1; i++) {
    if (midis[i - 1] !== null && midis[i] !== null && midis[i + 1] !== null) {
      const s = [midis[i - 1], midis[i], midis[i + 1]].sort((a, b) => a - b);
      track[i] = s[1];
    }
  }

  const segments = [];
  let cur = null;
  let gap = 0;
  const finish = () => {
    if (cur && cur.list.length >= MIN_NOTE_FRAMES) {
      // Frame i's estimate describes the window centred at i*HOP + WINDOW/2;
      // pad half a hop each side so the note covers its onset and release.
      const startSample = Math.max(0, cur.first * EDIT_HOP + EDIT_WINDOW / 2 - EDIT_HOP / 2);
      const endSample = cur.last * EDIT_HOP + EDIT_WINDOW / 2 + EDIT_HOP / 2;
      const medianMidi = median(cur.list);
      segments.push({
        startSample,
        endSample,
        startTime: startSample / sr,
        endTime: endSample / sr,
        medianMidi,
        baseMidi: Math.round(medianMidi),
        targetMidi: null, // null = untouched; normal scale snapping applies
        mono: false,
        runLen: 1,
      });
    }
    cur = null;
  };

  for (let i = 0; i < track.length; i++) {
    const m = track[i];
    if (m === null) {
      gap++;
      // A short unvoiced gap (a breath, a consonant) stays inside the note.
      if (cur && gap > 2) finish();
      continue;
    }
    if (cur) {
      // Compare against the median of the last few frames so vibrato and
      // slow drift don't split a held note.
      const recent = median(cur.list.slice(-4));
      if (Math.abs(m - recent) <= NOTE_SPLIT_SEMITONES) {
        cur.list.push(m);
        cur.last = i;
        gap = 0;
        continue;
      }
      finish();
    }
    cur = { first: i, last: i, list: [m] };
    gap = 0;
  }
  finish();
  return segments;
}

// --- Editor state ---

let noteSegments = null;
let noteDuration = 0;
let selectedNoteIndex = -1;
let noteDrag = null;
let rollLowMidi = 48;
let rollRows = 14;

function effectiveMidi(seg) {
  return seg.targetMidi !== null ? seg.targetMidi : seg.baseMidi;
}

// Flag runs of 3+ consecutive notes on the same pitch — the "too monotone"
// case the hints are there to fix. Recomputed after every edit so fixing a
// run clears its marks.
function markMonotoneRuns() {
  const n = noteSegments.length;
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && effectiveMidi(noteSegments[j + 1]) === effectiveMidi(noteSegments[i])) j++;
    const len = j - i + 1;
    for (let k = i; k <= j; k++) {
      noteSegments[k].mono = len >= 3;
      noteSegments[k].runLen = len;
    }
    i = j + 1;
  }
}

function buildNoteMap() {
  if (!noteSegments) return null;
  return noteSegments
    .filter((s) => s.targetMidi !== null)
    .map((s) => ({ start: Math.round(s.startSample), end: Math.round(s.endSample), midi: s.targetMidi }));
}

function resetNoteEditor() {
  noteSegments = null;
  noteDuration = 0;
  selectedNoteIndex = -1;
  noteDrag = null;
  noteEditor.classList.add('hidden');
  hintChipsEl.innerHTML = '';
  noteHintsEl.textContent = '';
  noteInfoEl.textContent = 'No note selected.';
}

async function analyzeTake() {
  if (!rawBlob) return;
  editNotesButton.disabled = true;
  const prevLabel = editNotesButton.textContent;
  editNotesButton.textContent = 'Analyzing…';
  statusEl.textContent = 'Analyzing the take into notes…';
  let decodeCtx = null;
  try {
    const arrayBuf = await rawBlob.arrayBuffer();
    decodeCtx = new (window.AudioContext || window.webkitAudioContext)();
    const audioBuffer = await decodeCtx.decodeAudioData(arrayBuf);
    const segments = await extractNoteSegments(audioBuffer);
    if (!segments.length) {
      resetNoteEditor();
      statusEl.textContent = 'No sung notes found in this take — try a longer or louder take.';
      return;
    }
    noteSegments = segments;
    noteDuration = audioBuffer.duration;
    selectedNoteIndex = -1;
    markMonotoneRuns();
    computeRollRange();
    noteEditor.classList.remove('hidden');
    resizePianoRoll();
    drawPianoRoll();
    updateNotePanel();
    statusEl.textContent = `Found ${segments.length} notes. Click one to move it up or down.`;
  } catch (err) {
    statusEl.textContent = `Note analysis failed: ${err.message}`;
  } finally {
    if (decodeCtx) decodeCtx.close();
    editNotesButton.textContent = prevLabel;
    editNotesButton.disabled = !rawBlob;
  }
}

// --- Piano roll ---

function computeRollRange() {
  let mn = Infinity;
  let mx = -Infinity;
  for (const seg of noteSegments) {
    const shown = effectiveMidi(seg);
    mn = Math.min(mn, seg.baseMidi, shown);
    mx = Math.max(mx, seg.baseMidi, shown);
  }
  mn -= 2;
  mx += 2;
  while (mx - mn + 1 < 12) {
    mn--;
    mx++;
  }
  rollLowMidi = mn;
  rollRows = mx - mn + 1;
}

function resizePianoRoll() {
  const dpr = window.devicePixelRatio || 1;
  pianoRoll.width = pianoRoll.clientWidth * dpr;
  pianoRoll.height = pianoRoll.clientHeight * dpr;
  rollCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function drawPianoRoll() {
  if (!noteSegments) return;
  const w = pianoRoll.clientWidth;
  const h = pianoRoll.clientHeight;
  const rowH = h / rollRows;
  const rowY = (midi) => h - (midi - rollLowMidi + 1) * rowH;
  rollCtx.clearRect(0, 0, w, h);

  for (let r = 0; r < rollRows; r++) {
    const midi = rollLowMidi + r;
    const y = h - (r + 1) * rowH;
    if (isInScale(midi)) {
      rollCtx.fillStyle = 'rgba(125, 211, 252, 0.07)';
      rollCtx.fillRect(0, y, w, rowH);
    }
    rollCtx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
    rollCtx.beginPath();
    rollCtx.moveTo(0, y + 0.5);
    rollCtx.lineTo(w, y + 0.5);
    rollCtx.stroke();
    if (rowH >= 9) {
      rollCtx.fillStyle = midi % 12 === 0 ? 'rgba(226, 232, 240, 0.7)' : 'rgba(148, 163, 184, 0.45)';
      rollCtx.font = `${Math.min(10, rowH - 1)}px sans-serif`;
      rollCtx.fillText(midiToNoteName(midi), 3, y + rowH - 2);
    }
  }

  const scaleX = w / noteDuration;
  noteSegments.forEach((seg, i) => {
    const x = seg.startTime * scaleX;
    const nw = Math.max(3, (seg.endTime - seg.startTime) * scaleX - 1);
    const edited = seg.targetMidi !== null;
    if (edited) {
      // Ghost outline at the originally sung pitch.
      const gy = rowY(seg.baseMidi);
      rollCtx.strokeStyle = 'rgba(125, 211, 252, 0.4)';
      rollCtx.setLineDash([3, 3]);
      rollCtx.strokeRect(x + 0.5, gy + 1.5, nw - 1, rowH - 3);
      rollCtx.setLineDash([]);
    }
    const shown = effectiveMidi(seg);
    const y = rowY(shown);
    rollCtx.fillStyle = edited ? '#fbbf24' : '#7dd3fc';
    rollCtx.fillRect(x, y + 1, nw, rowH - 2);
    if (seg.mono) {
      rollCtx.fillStyle = '#f472b6';
      rollCtx.fillRect(x, y + rowH - 2.5, nw, 2);
    }
    if (i === selectedNoteIndex) {
      rollCtx.strokeStyle = '#ffffff';
      rollCtx.lineWidth = 2;
      rollCtx.strokeRect(x - 1, y, nw + 2, rowH);
      rollCtx.lineWidth = 1;
    }
    if (nw >= 24 && rowH >= 10) {
      rollCtx.fillStyle = '#0f172a';
      rollCtx.font = `600 ${Math.min(10, rowH - 3)}px sans-serif`;
      rollCtx.fillText(midiToNoteName(shown), x + 3, y + rowH - 3);
    }
  });

  // Playhead synced to the audio player, to match notes to what's heard.
  const t = playbackAudio.currentTime;
  if (t > 0 && t <= noteDuration) {
    rollCtx.strokeStyle = 'rgba(248, 113, 113, 0.9)';
    rollCtx.beginPath();
    rollCtx.moveTo(t * scaleX + 0.5, 0);
    rollCtx.lineTo(t * scaleX + 0.5, h);
    rollCtx.stroke();
  }
}

let rollAnimId = null;
function rollAnimate() {
  drawPianoRoll();
  rollAnimId =
    !playbackAudio.paused && !playbackAudio.ended ? requestAnimationFrame(rollAnimate) : null;
}

// --- Editing interactions ---

function setNoteTarget(seg, midi) {
  const clamped = Math.max(24, Math.min(96, midi)); // C1..C7; the shifter clamps to ±1 octave anyway
  seg.targetMidi = clamped === seg.baseMidi ? null : clamped;
  markMonotoneRuns();
  computeRollRange();
  updateNotePanel();
  drawPianoRoll();
}

function nudgeSelected(delta) {
  if (selectedNoteIndex < 0) return;
  const seg = noteSegments[selectedNoteIndex];
  setNoteTarget(seg, effectiveMidi(seg) + delta);
}

function rollPointerPos(e) {
  const rect = pianoRoll.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

pianoRoll.addEventListener('pointerdown', (e) => {
  if (!noteSegments) return;
  const { x, y } = rollPointerPos(e);
  const h = pianoRoll.clientHeight;
  const rowH = h / rollRows;
  const scaleX = pianoRoll.clientWidth / noteDuration;
  let hit = -1;
  for (let i = 0; i < noteSegments.length; i++) {
    const seg = noteSegments[i];
    const sx = seg.startTime * scaleX;
    const sw = Math.max(3, (seg.endTime - seg.startTime) * scaleX - 1);
    const sy = h - (effectiveMidi(seg) - rollLowMidi + 1) * rowH;
    if (x >= sx - 2 && x <= sx + sw + 2 && y >= sy - 2 && y <= sy + rowH + 2) {
      hit = i;
      break;
    }
  }
  selectedNoteIndex = hit;
  if (hit >= 0) {
    noteDrag = { startY: y, startMidi: effectiveMidi(noteSegments[hit]), rowH, moved: false };
    pianoRoll.setPointerCapture(e.pointerId);
    // Jump playback to the note so it's easy to hear which one it is.
    if (playbackAudio.src) {
      try {
        playbackAudio.currentTime = noteSegments[hit].startTime;
      } catch {
        // not seekable yet — fine, selection still works
      }
    }
  } else {
    noteDrag = null;
  }
  updateNotePanel();
  drawPianoRoll();
});

pianoRoll.addEventListener('pointermove', (e) => {
  if (!noteDrag || selectedNoteIndex < 0) return;
  const { y } = rollPointerPos(e);
  const steps = Math.round((noteDrag.startY - y) / noteDrag.rowH);
  const seg = noteSegments[selectedNoteIndex];
  // Clamp to the current view during the drag (the range has 2 semitones of
  // padding); it re-expands on release so bigger moves just take two drags.
  const next = Math.max(rollLowMidi, Math.min(rollLowMidi + rollRows - 1, noteDrag.startMidi + steps));
  if (next !== effectiveMidi(seg)) {
    seg.targetMidi = next === seg.baseMidi ? null : next;
    noteDrag.moved = true;
    markMonotoneRuns();
    updateNotePanel();
    drawPianoRoll();
  }
});

function endNoteDrag() {
  if (noteDrag && noteDrag.moved) {
    computeRollRange();
    drawPianoRoll();
  }
  noteDrag = null;
}
pianoRoll.addEventListener('pointerup', endNoteDrag);
pianoRoll.addEventListener('pointercancel', endNoteDrag);

// --- Selected-note panel and hints ---

function updateNotePanel() {
  const seg = selectedNoteIndex >= 0 ? noteSegments[selectedNoteIndex] : null;
  noteUpButton.disabled = !seg;
  noteDownButton.disabled = !seg;
  noteResetButton.disabled = !seg || seg.targetMidi === null;
  if (!seg) {
    noteInfoEl.textContent =
      noteSegments && noteSegments.length ? 'No note selected — click a note above.' : '';
  } else {
    const cents = Math.round((seg.medianMidi - seg.baseMidi) * 100);
    const sung = `${midiToNoteName(seg.baseMidi)} (${cents >= 0 ? '+' : ''}${cents}¢)`;
    const info = `Note ${selectedNoteIndex + 1} of ${noteSegments.length}: sung ${sung}`;
    noteInfoEl.textContent =
      seg.targetMidi !== null ? `${info} — moving to ${midiToNoteName(seg.targetMidi)}` : info;
  }
  updateHints(seg);
}

function updateHints(seg) {
  hintChipsEl.innerHTML = '';
  if (!noteSegments || !noteSegments.length) {
    noteHintsEl.textContent = '';
    return;
  }
  const keyName = NOTE_NAMES[Number(keySelect.value)];
  const scaleName = scaleSelect.value;
  if (!seg) {
    const monoCount = noteSegments.filter((s) => s.mono).length;
    noteHintsEl.textContent = monoCount
      ? `Hint: ${monoCount} notes sit in repeated-pitch runs (pink underline) — the melody will sound monotone. Click one and try a suggested target.`
      : 'Click a note to see suggested targets. A dashed outline marks a moved note’s original pitch.';
    return;
  }

  const cur = effectiveMidi(seg);
  const up = nextScaleNote(cur, 1);
  const down = nextScaleNote(cur, -1);
  const chips = [
    { midi: up, label: `▲ ${midiToNoteName(up)}` },
    { midi: down, label: `▼ ${midiToNoteName(down)}` },
  ];
  if (seg.mono) {
    // A scale third above — a stronger melodic move for breaking up a run.
    const leap = nextScaleNote(up, 1);
    chips.push({ midi: leap, label: `▲▲ ${midiToNoteName(leap)}` });
  }

  const scaleText =
    scaleName === 'chromatic' ? 'nearest semitones' : `nearest notes in ${keyName} ${scaleName}`;
  if (seg.mono) {
    noteHintsEl.textContent = `This pitch repeats ${seg.runLen}× in a row — moving some of the repeats gives the line a melody. Suggested targets (${scaleText}):`;
  } else if (!isInScale(seg.baseMidi)) {
    noteHintsEl.textContent = `${midiToNoteName(seg.baseMidi)} is outside ${keyName} ${scaleName}. Suggested targets (${scaleText}):`;
  } else {
    noteHintsEl.textContent = `Suggested targets (${scaleText}):`;
  }
  for (const chip of chips) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'hint-chip';
    btn.textContent = chip.label;
    btn.addEventListener('click', () => setNoteTarget(seg, chip.midi));
    hintChipsEl.appendChild(btn);
  }
}

// --- Editor wiring ---

editNotesButton.addEventListener('click', analyzeTake);
noteUpButton.addEventListener('click', () => nudgeSelected(1));
noteDownButton.addEventListener('click', () => nudgeSelected(-1));
noteResetButton.addEventListener('click', () => {
  if (selectedNoteIndex >= 0) {
    const seg = noteSegments[selectedNoteIndex];
    setNoteTarget(seg, seg.baseMidi);
  }
});
noteResetAllButton.addEventListener('click', () => {
  if (!noteSegments) return;
  noteSegments.forEach((s) => {
    s.targetMidi = null;
  });
  markMonotoneRuns();
  computeRollRange();
  updateNotePanel();
  drawPianoRoll();
});
renderEditsButton.addEventListener('click', () => {
  const map = buildNoteMap();
  if (map && !map.length) {
    statusEl.textContent = 'No note edits yet — rendering with normal snapping.';
  }
  retune(map);
});

playbackAudio.addEventListener('play', () => {
  if (noteSegments && rollAnimId === null) rollAnimate();
});
playbackAudio.addEventListener('pause', () => {
  if (noteSegments) drawPianoRoll();
});
playbackAudio.addEventListener('seeked', () => {
  if (noteSegments) drawPianoRoll();
});

window.addEventListener('resize', () => {
  if (noteSegments && !noteEditor.classList.contains('hidden')) {
    resizePianoRoll();
    drawPianoRoll();
  }
});

startButton.addEventListener('click', () => {
  if (running) stop();
  else start();
});

recordButton.addEventListener('click', toggleRecord);
detectKeyButton.addEventListener('click', startDetectKey);
presetButtons.forEach((btn) => btn.addEventListener('click', () => applyPreset(btn.dataset.preset)));
retuneButton.addEventListener('click', () => retune());
fileInput.addEventListener('change', handleFileUpload);

// The note editor's scale tint and hints depend on the key/scale, so refresh
// them when either changes while the editor is open.
function refreshNoteEditorScale() {
  if (!noteSegments) return;
  drawPianoRoll();
  updateNotePanel();
}

keySelect.addEventListener('change', () => {
  sendParams();
  saveSettings();
  updateGuidance();
  refreshNoteEditorScale();
});
scaleSelect.addEventListener('change', () => {
  sendParams();
  saveSettings();
  updateGuidance();
  refreshNoteEditorScale();
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
