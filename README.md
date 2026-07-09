# Autotune Lite

A lightweight, dependency-free browser app that autotunes your voice in real
time. Built as a quick, fun demo — sing into your mic and hear yourself
snapped to the nearest note in a chosen key and scale.

## How it works

- **Pitch detection**: an `AudioWorkletProcessor` runs autocorrelation over
  short analysis windows to estimate your voice's fundamental frequency.
- **Note snapping**: the detected pitch is mapped to the nearest note in the
  selected key/scale (Chromatic, Major, or Minor).
- **Pitch shifting**: a simple granular (overlap-add) resampler shifts the
  live audio toward the target note. It's a lightweight approximation of
  real Auto-Tune, not a studio-grade PSOLA implementation — good enough for
  a fun demo, not for a record label.

No build step, no npm dependencies — just static files and the Web Audio
API.

## Running it

```bash
node server.js
```

Then open http://localhost:8080 in Chrome, Edge, or Firefox, click **Start**,
and allow microphone access.

**Use headphones** — otherwise the mic will pick up the autotuned output
from your speakers and cause feedback/echo.

## Controls

- **Key / Scale** — choose the musical key and scale to snap notes to.
  "Chromatic" snaps to the nearest semitone (works in any key); Major/Minor
  snap only to notes in that scale, for a more obviously "in tune" or
  T-Pain-style robotic effect.
- **Correction Strength** — how strongly pitch is pulled toward the target
  note (0% = no correction, 100% = full snap).
- **Wet / Dry Mix** — blend between your raw voice and the autotuned signal.

## Browser support

Requires a browser with `AudioWorklet` support (current Chrome, Edge,
Firefox, Safari). Microphone access requires a secure context — `localhost`
qualifies automatically, no HTTPS setup needed for local demos.
