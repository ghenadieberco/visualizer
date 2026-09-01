# Visualizer

A browser-based, audio-reactive visualizer. A full-screen WebGL canvas (Three.js) renders one of seven fixed presets, animated in real time from the microphone signal.

**Presets:** Spectrum Tunnel · Radial Spectrum Burst · Frequency Terrain · Waveform · Starfield Warp · Liquid Waves · Sphere

- **Mic-driven:** requests microphone access on load and analyses it locally — level (dB), FFT bands, waveform, and spectral-flux beat detection. Audio is never routed to output, recorded, or transmitted.
- **Beat-first reactivity:** onsets drive pulses, with level as a secondary continuous driver, including whole-scene opacity (floored so silence dims rather than blanks).
- **Effects:** three global controls that layer over any preset — **Glow** (bloom, 0 = off), **Move** (extra random drift on top of the preset's own motion, 0 = off) and **Color** (saturation + brightness together, 0–200%, 100% = the preset as authored).
- **Text overlay:** a caption typed into the panel renders dead centre in front of the camera — size in pixels, five system fonts (sans · serif · mono · display · condensed), multiple lines. It scales smoothly with the dB level — the size slider is its resting size, and level swells it up to +35%. It rides the camera, so it stays centred and upright through drag, Movement and zoom, and it sits inside the scene, so Glow and Color grade it with everything else.
- **Controls:** a collapsible right-hand panel for preset selection, zoom (30%–600%), effects, mic on/off, and live signal meters. Drag the canvas to look around. Keyboard: `H` panel, `F` fullscreen, `1`–`7` presets, arrows next/prev, `+` / `-` zoom, `0` reset view.
- **Motion safety:** reactivity is smoothed and slew-limited, with no full-screen strobing, and honours the OS `prefers-reduced-motion` setting.

Desktop browsers only (WebGL2, Web Audio, `getUserMedia`). The page is three files — [index.html](index.html) (markup), [app.css](app.css) (styles), [app.js](app.js) (ES module) — and loads Three.js plus its post-processing addons from a CDN, so first load needs network access.

Serve it over HTTP rather than opening the file directly; browsers refuse to load ES modules from `file://`:

```sh
python3 -m http.server 8000
# then open http://localhost:8000/
```

Full spec: [docs/Visualizer-Requirements.md](docs/Visualizer-Requirements.md)
