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
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
    });
  } catch (err) {
    statusEl.textContent = `Microphone access denied or unavailable: ${err.message}`;
    return;
  }

  audioContext = new (window.AudioContext || window.webkitAudioContext)();
  await audioContext.audioWorklet.addModule('pitch-processor.js');

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
  resizeCanvas();
  drawVisualizer();
}

function stop() {
  running = false;
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
}

function updateMix() {
  if (!dryGain || !wetGain) return;
  const mix = Number(mixSlider.value) / 100;
  dryGain.gain.value = 1 - mix;
  wetGain.gain.value = mix;
}

startButton.addEventListener('click', () => {
  if (running) stop();
  else start();
});

keySelect.addEventListener('change', sendParams);
scaleSelect.addEventListener('change', sendParams);
strengthSlider.addEventListener('input', sendParams);
mixSlider.addEventListener('input', updateMix);

resizeCanvas();
