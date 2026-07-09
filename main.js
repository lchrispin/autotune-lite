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
const bypassCheckbox = document.getElementById('bypass');
const recordButton = document.getElementById('recordButton');
const playback = document.getElementById('playback');
const playbackLabel = document.getElementById('playbackLabel');
const playbackAudio = document.getElementById('playbackAudio');
const downloadLink = document.getElementById('downloadLink');
const retuneButton = document.getElementById('retuneButton');

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
  if (saved.bypass !== undefined) bypassCheckbox.checked = saved.bypass;
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
        bypass: bypassCheckbox.checked,
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
    enabled: true,
  });
}

async function start() {
  // Guard against re-entrancy (e.g. a fast second click) during async setup.
  startButton.disabled = true;
  statusEl.textContent = 'Requesting microphone access…';

  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
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
  pitchNode = new AudioWorkletNode(audioContext, 'pitch-processor', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
  });

  dryGain = audioContext.createGain();
  wetGain = audioContext.createGain();
  analyser = audioContext.createAnalyser();
  analyser.fftSize = 2048;

  source.connect(dryGain);
  source.connect(pitchNode);
  pitchNode.connect(wetGain);

  dryGain.connect(analyser);
  wetGain.connect(analyser);
  analyser.connect(audioContext.destination);

  // Tap the same mixed signal the user hears so recordings capture correction.
  recordDest = audioContext.createMediaStreamDestination();
  analyser.connect(recordDest);

  // Also tap the raw mic (pre-gain) so a take can be re-tuned offline later.
  rawDest = audioContext.createMediaStreamDestination();
  source.connect(rawDest);

  updateMix();

  pitchNode.port.onmessage = (event) => {
    const msg = event.data;
    if (msg.type === 'pitch') {
      detectedEl.textContent = `Detected: ${midiToNoteName(msg.detectedMidi)} (${msg.detectedFreq.toFixed(1)} Hz)`;
      targetEl.textContent = `Target: ${midiToNoteName(msg.targetMidi)} (${msg.targetFreq.toFixed(1)} Hz)`;
    } else if (msg.type === 'silence') {
      detectedEl.textContent = 'Detected: —';
      targetEl.textContent = 'Target: —';
    }
  };

  sendParams();

  running = true;
  statusEl.textContent = 'Listening — sing into the mic. Use headphones to avoid feedback.';
  startButton.textContent = 'Stop';
  startButton.disabled = false;
  recordButton.disabled = false;
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

// Render a mono AudioBuffer to a 16-bit PCM WAV blob (OfflineAudioContext
// hands back raw samples, so we encode them ourselves — no dependencies).
function audioBufferToWav(buffer) {
  const samples = buffer.getChannelData(0);
  const n = samples.length;
  const sr = buffer.sampleRate;
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

    const offline = new OfflineAudioContext(1, audioBuffer.length, audioBuffer.sampleRate);
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
      enabled: true,
    });
    srcNode.connect(node);
    node.connect(offline.destination);
    srcNode.start();

    const rendered = await offline.startRendering();
    const wavBlob = audioBufferToWav(rendered);
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

function updateStrengthLabel() {
  strengthValue.textContent = `${strengthSlider.value}%`;
}

startButton.addEventListener('click', () => {
  if (running) stop();
  else start();
});

recordButton.addEventListener('click', toggleRecord);
retuneButton.addEventListener('click', retune);

keySelect.addEventListener('change', () => {
  sendParams();
  saveSettings();
});
scaleSelect.addEventListener('change', () => {
  sendParams();
  saveSettings();
});
strengthSlider.addEventListener('input', () => {
  updateStrengthLabel();
  sendParams();
  saveSettings();
});
mixSlider.addEventListener('input', () => {
  updateMix();
  saveSettings();
});
bypassCheckbox.addEventListener('change', () => {
  updateMix();
  saveSettings();
});

loadSettings();
updateStrengthLabel();
updateMix();
resizeCanvas();
