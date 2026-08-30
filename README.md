# Visualizer

A browser-based, audio-reactive visualizer. A full-screen WebGL canvas (Three.js) renders one of five fixed presets, animated in real time from the microphone signal.

**Presets:** Spectrum Tunnel · Radial Spectrum Burst · Frequency Terrain · Waveform Ribbon · Starfield Warp · Liquid Waves

- **Mic-driven:** requests microphone access on load and analyses it locally — level (dB), FFT bands, waveform, and spectral-flux beat detection. Audio is never routed to output, recorded, or transmitted.
- **Beat-first reactivity:** onsets drive pulses, with level as a secondary continuous driver, including whole-scene opacity (floored so silence dims rather than blanks).
- **Controls:** a collapsible right-hand panel for preset selection, zoom (30%–600%), mic on/off, and live signal meters. Keyboard: `H` panel, `F` fullscreen, `1`–`6` presets, arrows next/prev, `+` / `-` / `0` zoom.
- **Motion safety:** reactivity is smoothed and slew-limited, with no full-screen strobing, and honours the OS `prefers-reduced-motion` setting.

Desktop browsers only (WebGL2, Web Audio, `getUserMedia`). The page is three files — [index.html](index.html) (markup), [app.css](app.css) (styles), [app.js](app.js) (ES module) — and loads Three.js from a CDN, so first load needs network access.

Serve it over HTTP rather than opening the file directly; browsers refuse to load ES modules from `file://`:

```sh
python3 -m http.server 8000
# then open http://localhost:8000/
```

Full spec: [docs/Visualizer-Requirements.md](docs/Visualizer-Requirements.md)
