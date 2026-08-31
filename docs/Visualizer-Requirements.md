# Visualizer — Requirements

**Version:** 0.8 (draft) · **Date:** 2026-08-31 · **Status:** For review

A browser-based, audio-reactive visualizer. A full-screen WebGL canvas renders one of several fixed presets, animated in real time from the microphone signal. A collapsible right-hand panel selects presets and controls the view and the mic.

> **Changes since 0.7:** added a global **Effects** panel group — Glow (bloom), Move (random drift) and Color (saturation + brightness) — and **drag-to-look** in the viewport. Presets stay fixed; these compose on top of them.
> **Changes since 0.6:** added the **Sphere** preset — a wire-mesh globe with glowing edges whose relief is displaced by level and frequency, bringing the set to seven.
> **Changes since 0.5:** replaced **Waveform Ribbon** with **Waveform** — a real-time oscilloscope trace: a single stroked line whose curve follows the live time-domain signal, with an additive multi-pass glow, an armed edge trigger to hold the trace steady, and frame-rate-independent smoothing.
> **Changes since 0.4:** added the **Liquid Waves** preset (black-silk sheet with anisotropic sheen), bringing the set to six; split the prototype page into `index.html` / `app.css` / `app.js`.
> **Changes since 0.3:** replaced **Kaleidoscope** with **Waveform Ribbon**; smoothed all animations and added reduced-motion support for photosensitivity safety (see NFR-8).
> **Changes since 0.2:** replaced four presets, keeping **Radial Spectrum Burst**.
> **Changes since 0.1:** audio source is now **microphone only** (file upload removed) and **auto-starts on load**; added **zoom** (view control) and **level-driven opacity** across all presets; removed file transport and the Space shortcut.

---

## 1. Scope

**In scope (v1)**

- Full-screen visual with a collapsible right side panel.
- Seven fixed presets, each with baked-in reactive behavior.
- Microphone as the sole audio source, requested and started on first load.
- Signal analysis: overall level (dB), frequency bands (FFT), and beat/onset detection.
- Animation driven primarily by beat/onset pulses, with level as a secondary continuous driver — including whole-preset opacity.
- Zoom (in/out) applied uniformly across every preset.

**Out of scope (v1)** — see §6.

---

## 2. Decisions locked in review

| Topic | Decision |
|---|---|
| Signal driving animation | Both loudness (dB) **and** frequency spectrum (FFT) |
| Preset properties | Fixed per preset (no live editing) |
| Rendering | WebGL / shader-based |
| Reactivity model | Beat / onset **pulses** (level is a secondary continuous driver) |
| Level-driven opacity | Every preset's overall opacity tracks dB level, floored so quiet ≠ black |
| Audio source | **Microphone only**; file upload removed for v1 |
| Startup | Request mic permission and begin listening on first page load |
| Zoom | Global zoom across all presets via scroll, buttons, and keys |
| Effects | Global glow, movement and colour intensity, layered over any preset |
| Camera | Drag to look around; composes with zoom and each preset's own motion |
| Target platform | Desktop browsers only |
| Preset set | spectrum tunnel · radial spectrum burst · frequency terrain · waveform · starfield warp · liquid waves · sphere |
| Motion safety | Smoothed/slew-limited reactivity; honors OS reduce-motion; no full-screen strobing |

---

## 3. Functional requirements

### 3.1 Display & layout

- **FR-1** The visual renders on a full-viewport canvas that resizes with the window.
- **FR-2** A right side panel can be shown or hidden via an edge handle and a keyboard shortcut; a persistent handle reopens it when hidden.
- **FR-3** A browser fullscreen toggle is available.
- **FR-4** When the panel is hidden the canvas occupies the full viewport; the transition is smooth.

### 3.2 View / zoom

- **FR-5** The user can zoom the visual in and out. Zoom applies to whichever preset is active and is shared (persists) across preset switches.
- **FR-6** Zoom is reachable three ways: scroll wheel over the canvas, panel buttons (−/+/Reset) with a live percentage readout, and keys (`+` / `-` / `0` reset).
- **FR-7** Zoom is clamped to a sensible range (currently 30%–600%) and composes with each preset's own camera motion (orbit/dolly) rather than replacing it.
- **FR-7a** Dragging the canvas looks around the scene: horizontal drag yaws, vertical drag pitches (clamped to ±1.2 rad so the view cannot invert). It composes with zoom, with Movement, and with the preset's own camera motion.
- **FR-7b** *View › Reset*, the `0` key and a double-click on the canvas all recentre zoom **and** the drag orientation.

### 3.2a Effects (global)

Three controls in a panel **Effects** group, applied to whichever preset is active and persisting across preset switches. Each is inert at its default, so a fresh load looks exactly as it did before the group existed.

- **FR-7c Glow** (0–100%, default 0) drives a bloom post-pass. The slider moves strength, luminance threshold and radius together — low settings halo only the hottest cores, high settings pull progressively more of the image into the glow — so the travel across the slider is visible rather than on/off. It glows what the preset draws and must not lift the background. Onsets swell it slightly.
- **FR-7d Movement** (0–100%, default 0) adds a slow random drift — rotation plus sway — on top of whatever the preset already animates. Amplitude and drift rate both scale with the slider, so it reads as motion *intensity*. Targets are re-rolled on a timer and kicked on strong onsets; sway is scaled by camera distance so one slider reads the same across presets of very different world sizes. Damped by `prefers-reduced-motion` (NFR-8).
- **FR-7e Color** (0–200%, default 100%) scales saturation and brightness together: 0 is desaturated and dark, 100% is the preset as authored, 200% is vivid and hot.

### 3.3 Presets

- **FR-8** The panel lists all presets with a name and a short descriptor; the active preset is clearly marked.
- **FR-9** Selecting a preset switches the visual immediately. Only the active preset renders.
- **FR-10** Preset visual properties are fixed and defined per preset; the user cannot edit them in v1.
- **FR-11** Each preset reacts to the shared signal inputs per the mapping below.
- **FR-12** Every preset's overall **opacity** tracks the dB level, floored (currently ~15%) so silence dims the scene toward the background instead of blanking to black.

**Preset reactive mappings**

| # | Preset | Level (dB) | Spectrum (FFT) | Beat pulse |
|---|---|---|---|---|
| 1 | Spectrum Tunnel | Fly-through speed | Ring radius profile (per-segment) | Speed surge + brightness |
| 2 | Radial Spectrum Burst | Rotation speed | Mirrored ray lengths | Radial flare (ring expands) |
| 3 | Frequency Terrain | Camera lift/sway | Row heights (scrolling spectrogram) | Height accent + camera lift |
| 4 | Waveform | Trace height + line thickness + glow gain | Uses time-domain waveform for the curve | Gentle glow swell |
| 5 | Starfield Warp | Warp speed + streak length | Broadband energy | Hyperspace burst |
| 6 | Liquid Waves | Fold amplitude + flow speed + sheen gain | Bands drive octave depth (low → drape, mid → creases, high → weave) | Ripple from centre + highlight flare |
| 7 | Sphere | Displacement amplitude + edge glow + spin speed | Latitude samples the spectrum (equator → lows, poles → highs); bands weight the noise octaves | Ripple travelling pole to pole + rim flare |

*Applies to all presets: overall opacity ← dB level (see FR-12).*

### 3.4 Audio input (microphone)

- **FR-13** The microphone is the only audio source in v1.
- **FR-14** On first page load the app requests microphone permission and, once granted, begins listening automatically.
- **FR-15** Mic audio is analyzed only and is **never** routed to output (no feedback).
- **FR-16** A mic control lets the user stop and restart listening; its label and status reflect the current state.
- **FR-17** The app handles the relevant states gracefully: requesting, live, denied/blocked (with retry + guidance), and no-device/error.
- **FR-18 (Autoplay)** If the browser suspends audio until user interaction, the app surfaces a "click anywhere to start" state and resumes on the first interaction.

### 3.5 Signal analysis

- **FR-19** Compute overall level as RMS, displayed in dB, and normalized for visuals and opacity.
- **FR-20** Compute an FFT spectrum and derive Low / Mid / High band energies.
- **FR-21** Detect beats/onsets from spectral flux with an adaptive threshold and a refractory window; emit a decaying pulse (1 → 0) that presets consume.
- **FR-22** A user-adjustable **sensitivity** control tunes onset detection.
- **FR-29** Extract a time-domain waveform for the Waveform preset: box-filtered downsample of a short window, aligned by an armed edge trigger (threshold tracking the signal peak) so a steady tone draws a steady trace, and normalized against a smoothed peak so quiet input still reads.
- **FR-30** All reactive signals are smoothed/slew-limited before driving visuals: gentle level attack/release, a floored and low-passed opacity, and a beat pulse that rises with a slew limit and decays gradually (see NFR-8).

### 3.6 Signal console (panel readouts)

- **FR-23** A level meter shows current dB with a peak-hold indicator.
- **FR-24** Low / Mid / High band meters render live.
- **FR-25** A beat indicator flashes on each detected onset; an estimated BPM is shown.
- **FR-26** A compact mic status tag reflects live/off/denied state.

### 3.7 Interaction

- **FR-27** Keyboard shortcuts: toggle panel (`H`), toggle fullscreen (`F`), select presets (`1`–`7`), next/previous preset (arrows), zoom (`+` / `-` / `0`).
- **FR-28** All interactive controls are reachable and operable by keyboard with visible focus.

---

## 4. Non-functional requirements

- **NFR-1 Performance:** target 60 fps at 1080p on a modern desktop GPU; cap device pixel ratio to control fill cost.
- **NFR-2 Platform:** current desktop Chrome, Edge, Firefox, Safari with WebGL2, Web Audio API, and `getUserMedia`.
- **NFR-3 Latency:** visible reaction to audio within ~1 animation frame of analysis.
- **NFR-4 Stability:** no audio feedback (mic never reaches output); graceful handling of denied permission, missing device, and browser autoplay suspension.
- **NFR-5 Accessibility floor:** keyboard operability, visible focus, sufficient contrast in the panel.
- **NFR-6 Footprint:** single self-contained page for the prototype; WebGL via Three.js.
- **NFR-7 Privacy:** microphone audio is processed locally in the browser only; it is never recorded, stored, or transmitted.
- **NFR-8 Motion & photosensitivity safety:** reactivity is smoothed and slew-limited so onsets read as swells rather than flashes; opacity has a raised floor and reduced range to avoid rapid full-field luminance swings; there is no full-screen strobing shader; and the app honors the OS `prefers-reduced-motion` setting to further damp motion and pulses. Aim: avoid sustained high-contrast flashing in the ~3–30 Hz range associated with photosensitive seizures.

---

## 5. Technical approach (prototype)

- Rendering: **Three.js** (WebGL2). Presets 1–5 build geometry on the CPU (instanced meshes, line sets, vertex-coloured meshes); presets 6–7 are custom GLSL `ShaderMaterial`s — simplex-noise displacement in the vertex shader, plus Kajiya-Kay anisotropic sheen (6) and barycentric wireframe (7) in the fragment shader.
- Sphere preset: an icosphere (near-uniform triangles) drawn twice from one geometry and one shared uniform block — a depth-writing near-black shell that occludes the far side, then an additive pass that derives glowing, screen-constant-width edges from per-triangle barycentric coordinates via `fwidth`. Vertex displacement reads the live spectrum from a 1-D `DataTexture` indexed by latitude; surface normals come from finite differences in a tangent frame.
- Source layout: `index.html` (markup) · `app.css` · `app.js` (ES module). The module must be served over HTTP; browsers refuse module loads from `file://`.
- Audio: **Web Audio API** — `AnalyserNode` for FFT and time-domain data; `MediaStreamSource` from `getUserMedia` for the mic (no output node). Autoplay suspension is resolved by resuming the context on the first user gesture.
- Beat detection: spectral-flux onset with adaptive mean-based threshold, refractory ~110 ms, exponential-decay pulse envelope.
- Effects: an `EffectComposer` chain — `RenderPass` → `UnrealBloomPass` → colour grade (`ShaderPass`). The composer is bypassed entirely while every effect sits at its default, so the untouched app renders straight to the canvas at no cost; the bloom pass is `enabled = false` until Glow leaves zero.
- Effects performance: every pass reads and writes the whole frame, so the chain is kept short. The grade pass also performs the linear → sRGB encode (saving a separate `OutputPass`), and the composer target carries **no MSAA** — resolving a multisampled half-float target every frame cost more than the rest of the chain combined (~3x the frame time). Together these cut the cost of an effect being on by roughly 3x, taking colour intensity to near free.
- Bloom resolution: the mip chain runs at the full drawing buffer, stepping down to 0.7 only above ~2.6 Mpx (4K, HiDPI over 1440p). Half resolution is cheaper still, but bands the halo on a thin bright trace and spreads it much wider — the frame-wide wash the glow is meant to avoid.
- Trade-off: with an effect on, edges are aliased where the direct path gets `antialias: true`. FXAA folded into the grade pass is the cheap way back if it proves visible.
- Render-target colour space: each preset scene sets `scene.background`. Without it, `RenderPass` clears a bound render target with the canvas-space (sRGB) clear value while the buffer is linear, and `OutputPass` then encodes it a second time — greying the whole frame. Naming the background makes three clear it in the working space instead.
- Drag + movement: both are summed into `scene.rotation` / `scene.position` of the preset's scene root, which no preset touches itself, and the root is fully reassigned every frame so nothing accumulates. Movement uses six eased random-walk channels (rotation xyz + sway xyz).
- Zoom: every preset uses a perspective or orthographic camera, so zoom is applied via the camera's `.zoom` (independent of position, so it composes with each preset's orbit/dolly/fly motion). No full-screen shader remains.
- Opacity: instanced-mesh presets set `material.opacity`; shader presets multiply a `uOpacity` uniform into output alpha. Both fed from the normalized dB level with a floor.
- Dependency note: the prototype loads Three.js and its `examples/jsm` post-processing addons from a CDN (via an import map) and needs network access on first load.

---

## 6. Out of scope / future

- **Audio file upload / playback** (was in 0.1; removed for v1, may return as an optional second source).
- System-audio / tab-audio capture; multiple simultaneous sources.
- Live-editable preset parameters and user-saved presets.
- Mobile / touch layout and pinch-to-zoom.
- Preset thumbnails/previews, colour themes.
- Recording or exporting video.
- Persisting last-used preset / zoom / mic state across sessions.

---

## 7. Open questions

1. Should band split points (Low/Mid/High crossover frequencies) be fixed or configurable?
2. Confirm the opacity floor (~15%) and zoom range (30%–600%) — keep, or expose as settings?
3. Should the effects path get FXAA to replace the MSAA it gives up (see performance note), or is the direct-path quality difference acceptable?
4. Confirm the effect ranges — glow max (bloom strength 1.25), movement amplitude, colour 0–200% — and whether effect settings should persist across sessions.
5. Any target minimum GPU / fallback if WebGL2 is unavailable?
4. Is estimated BPM a real requirement or a nice-to-have readout?
5. For the "textured" sphere — procedural texture (current) or support user-supplied image/video textures later?
6. Should mic on/off (and chosen preset) be remembered across reloads?
