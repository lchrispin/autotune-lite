# Autotune Lite

A lightweight, dependency-free browser app that autotunes your voice in real
time. Built as a quick, fun demo — sing into your mic and hear yourself
snapped to the nearest note in a chosen key and scale.

## How it works

- **Clean capture**: the mic is opened with the browser's speech-call
  processing (echo cancellation, noise suppression, auto gain) turned **off** —
  those are designed for phone calls and audibly mangle singing. A gentle
  70 Hz high-pass removes rumble and plosive thumps.
- **Pitch detection**: an `AudioWorkletProcessor` runs normalized
  autocorrelation (NSDF) over short analysis windows to estimate your voice's
  fundamental frequency. The track is conditioned with a median filter (so a
  single glitched frame can't cause an audible chirp) and DC removal.
- **Note snapping**: the detected pitch is mapped to the nearest note in the
  selected key/scale (Chromatic, Major, or Minor), with **hysteresis** — once
  a target note is chosen it's held until your pitch moves decisively toward a
  different note, so singing near the boundary between two notes doesn't
  warble back and forth. Correction strength is applied in cents (log
  frequency), so 50% strength always closes half the musical distance.
- **Pitch shifting**: time-domain **PSOLA** (pitch-synchronous overlap-add)
  moves the voice onto the target note. It extracts two-period, Hann-windowed
  grains on a pitch-locked grid and overlap-adds them at the target period, so
  adjacent grains stay in phase — the note lands on pitch cleanly instead of
  being partially corrected and warbly. Still a lightweight demo, not a
  studio-grade vocal processor, but the correction is now clearly audible.
- **Vocal polish**: the mixed output runs through light compression
  (3:1, soft knee) with a touch of makeup gain, evening out levels and adding
  a produced sheen. The dry path is delayed to match the pitch engine's
  latency, so intermediate Wet/Dry mixes sound like a doubled voice rather
  than a slapback echo.

No build step, no npm dependencies — just static files and the Web Audio
API.

## Running it

```bash
node server.js
```

Then open http://localhost:8080 in Chrome, Edge, or Firefox, click **Start**,
and allow microphone access.

**Use headphones** — otherwise the mic will pick up the autotuned output
from your speakers and cause feedback/echo. No headphones handy? Untick
**Live monitor** instead: the speakers stay silent (so no feedback), while the
tuner, visualizer, and recording keep running on the corrected signal — record
your take, then play it back to hear the result.

## Controls

- **Key / Scale** — choose the musical key and scale to snap notes to.
  "Chromatic" snaps to the nearest semitone (works in any key); Major/Minor
  snap only to notes in that scale, for a more obviously "in tune" or
  T-Pain-style robotic effect.
- **Correction Strength** — how strongly pitch is pulled toward the target
  note (0% = no correction, 100% = full snap).
- **Retune Speed** — how quickly the pitch snaps to the target. Low = a slow,
  natural glide into tune; high = the near-instant robotic snap of hard
  Auto-Tune.
- **Wet / Dry Mix** — blend between your raw voice and the autotuned signal.
- **Bypass** — instantly hear your raw voice (ignores the mix slider), handy
  for A/B-ing the effect on and off.
- **Live monitor** — toggles speaker output. Turn it off to sing without
  headphones: no feedback, the tuner and visualizer keep working, and
  recordings still capture the autotuned voice.
- **Presets** — one-click starting points: **Subtle** (gentle, natural),
  **Pop** (noticeable but musical), **Hard Tune** (full robotic snap). They set
  the strength, mix, and retune speed for you; tweak a slider afterwards to
  fine-tune.

A **tuning meter** above the waveform shows how far your detected pitch sits
from the target note (flat on the left, sharp on the right); the needle turns
green when you're essentially in tune.

A short line under the controls describes the current effect in plain language,
so you can tell at a glance whether you're set to "gentle, natural tuning" or a
"hard robotic snap". All control settings are remembered in `localStorage`, so
they persist across page reloads.

### Detecting the key

Not sure what key you're singing in? Click **Detect Key** while listening and
sing for a few seconds — the app builds a pitch histogram and uses the
Krumhansl-Schmuckler key-finding algorithm to pick the most likely key and
scale, then sets them for you.

## Recording

While listening, click **● Record** to capture your take, then **■ Stop
Recording** to finish. The recording captures the same mixed signal you hear —
so the autotune correction is baked in — and appears below the visualizer as a
playback player with a **Download** link. Recording uses the browser's
`MediaRecorder` (WebM/Opus where supported, with MP4/Ogg fallbacks).

### Re-tuning a take

Each recording also captures your **raw (dry) voice** in the background. Change
the key, scale, correction strength, or retune speed, then click **Re-tune with
current settings** to re-run that same performance through the pitch engine
offline — no need to sing it again. Re-tuning renders through an
`OfflineAudioContext` using the exact same processing chain you hear live
(high-pass, pitch engine, polish compression), compensates for the engine's
latency so the result lines up with the original from the first sample, and
produces a downloadable WAV — so you can quickly A/B the same take in
different keys.

You don't have to record here to use this: pick any audio file with **Or
re-tune an existing audio file** and it becomes the re-tune source. Choose a
key/scale/strength and click **Re-tune** to get an autotuned WAV back — no
microphone needed.

## Browser support

Requires a browser with `AudioWorklet` support (current Chrome, Edge,
Firefox, Safari). Microphone access requires a secure context — `localhost`
qualifies automatically, no HTTPS setup needed for local demos.
