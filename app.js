import * as THREE from 'three';
import { EffectComposer }  from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass }      from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass }      from 'three/addons/postprocessing/ShaderPass.js';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

/* =========================================================================
   RENDERER
   ========================================================================= */
const canvas = document.getElementById('gl');
const renderer = new THREE.WebGLRenderer({ canvas, antialias:true, powerPreference:'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
const BG = 0x0b0c10;
renderer.setClearColor(BG, 1);
let W = innerWidth, H = innerHeight;
function sizeRenderer(){ W = innerWidth; H = innerHeight; renderer.setSize(W, H); }
sizeRenderer();

// global view + effect state shared by all presets
//   zoom     camera zoom (0.3 - 6)
//   glow     bloom amount, 0 = off (post-pass bypassed entirely)
//   flare    lens-flare amount, 0 = off (its passes bypassed entirely)
//   movement extra random drift on top of the preset's own motion, 0 = off
//   colour   saturation + brightness multiplier, 1 = the preset's own look
//   orbit    look direction from dragging the viewport (pitch, yaw in radians)
//   text     overlay caption: its lines, screen size in px, font stack key,
//            fill colour, and its own glow — deliberately separate from `glow`
const state = { zoom: 1, glow: 0, flare: 0, movement: 0, colour: 1, orbit:{ x:0, y:0 },
                text: '', textSize: 72, textFont: 'sans',
                textColour: '#ffffff', textGlow: 0 };

// respect the OS "reduce motion" accessibility setting → damp motion + pulses
const REDUCED_MOTION = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const MOTION = REDUCED_MOTION ? 0.5 : 1;

/* =========================================================================
   POST-PROCESSING  —  Glow (bloom), Flare (lens artifact) and Color
   (saturation + brightness). While all three sit at their defaults the
   composer is skipped entirely and the scene renders straight to the canvas,
   so an untouched panel costs nothing and looks exactly as it always has.
   ========================================================================= */
// The slider drives strength, threshold and radius together. Strength alone
// reads as on/off: a fixed threshold means every bright pixel blooms the moment
// the slider leaves zero, and the halo just clips harder after that. Sweeping
// the threshold down as well means low settings glow only the hottest cores and
// high settings pull progressively more of the image into the halo, so the
// travel between 10% and 100% is something you can actually see.
const GLOW_MAX = 1.45;                      // bloom strength at slider 100%
const glowStrength = t => GLOW_MAX * Math.pow(t, 1.75);
const glowThreshold = t => 0.85 - 0.60*t;   // 0.85 (hottest cores only) -> 0.25
// UnrealBloomPass's radius is what mixes its five mips from "favour the sharpest"
// toward "favour the widest": push it high and a strong glow becomes a haze over
// the whole frame rather than a halo on what is bright. Kept short of that.
const glowRadius    = t => 0.25 + 0.40*t;
const dpr = renderer.getPixelRatio();
// HalfFloat so additive highlights can exceed 1.0 and actually feed the bloom.
// No MSAA: resolving a multisampled half-float target every frame cost more
// than the rest of the post chain put together (~2.5x the whole frame), and the
// effects are only ever on top of a scene that is mostly glowing thin lines.
const fxTarget = new THREE.WebGLRenderTarget(W*dpr, H*dpr, { type:THREE.HalfFloatType, samples:0 });
const composer = new EffectComposer(renderer, fxTarget);
const renderPass = new RenderPass(null, null);            // scene/camera swapped in per frame

// Colour intensity: one slider for overall punch. Saturation pivots around the
// pixel's own luminance and brightness scales on top, so 0 is washed out and
// dark, 100 is the preset as authored, 200 is vivid and hot.
// This pass also performs the linear -> sRGB output encode. Keeping the two
// together saves a full-resolution pass over three's separate OutputPass, which
// matters because every pass here reads and writes the whole frame — and being
// last in the chain, it is the only pass allowed to encode.
const gradePass = new ShaderPass({
  uniforms: { tDiffuse:{value:null}, uSat:{value:1}, uBright:{value:1} },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float uSat, uBright; varying vec2 vUv;
    const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);         // Rec.709, linear space
    void main(){
      vec4 t = texture2D(tDiffuse, vUv);
      vec3 c = max(mix(vec3(dot(t.rgb, LUMA)), t.rgb, uSat) * uBright, 0.0);
      // same transfer function three applies on a direct render, so glow off /
      // glow on differ only by the effect itself
      c = mix(pow(c, vec3(0.41666))*1.055 - 0.055, c*12.92, vec3(lessThanEqual(c, vec3(0.0031308))));
      gl_FragColor = vec4(c, t.a);
    }`
});
const bloomPass = new UnrealBloomPass(new THREE.Vector2(W, H), 0, 0.45, 0.5);
bloomPass.enabled = false;

/* -------------------------------------------------------------------------
   LENS FLARE  —  the camera artifact a bright preset would throw in a real
   lens: ghosts mirrored through the centre of frame and an anamorphic streak.
   There is deliberately no halo ring, the third feature the textbook version
   has. It assumes small, point-like sources; every preset here is a bright
   object filling most of the frame, so its ring covers the screen and the
   effect collapses into a smear rather than reading as a lens. It is derived from the frame itself, so nothing has to be
   authored per preset — whatever a preset draws brightly flares, and a preset
   with nothing hot in it produces nothing.
   It is generated from the scene *before* the bloom, so it fires on the
   preset's own hot pixels whether or not Glow is up and the two sliders stay
   independent — two artifacts of the same light rather than one feeding the
   other. Four steps, all but the composite at quarter resolution: threshold
   the frame, build the features, soften them with a separable blur, then add
   the result over the frame.
   ------------------------------------------------------------------------- */
const FLARE_DIV = 4;                        // flare buffers run at 1/4 the drawing buffer
// As with Glow, the slider sweeps the threshold as well as the strength: low
// settings flare only on the hottest cores, high settings pull more of the
// image into it, so the travel across the slider is visible rather than on/off.
// The range is set from what the presets actually put on screen, not from the
// nominal 0-1: measured across the set, linear luminance peaks around 0.5-0.9
// and only a per-cent or two of the frame clears 0.5, so a bloom-like 0.85
// threshold would leave the whole slider dead.
const flareStrength   = t => 1.3 * Math.pow(t, 1.5);
const flareThreshold  = t => 0.55 - 0.37*t;   // 0.55 (hottest cores only) -> 0.18
const flareDistortion = t => 0.0015 + 0.0035*t; // chromatic split between the R and B ghosts, in uv
const FLARE_VERT = `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`;
const flareMat = (uniforms, fragmentShader) => new THREE.ShaderMaterial({
  uniforms, fragmentShader, vertexShader: FLARE_VERT, depthTest: false, depthWrite: false
});

class FlarePass extends Pass {
  constructor(){
    super();
    this.needsSwap = false;                 // writes only to its own buffers
    // No depth: these are pure image buffers, and without a depth attachment
    // there is nothing for a stale, never-cleared depth test to reject.
    const opts = { type:THREE.HalfFloatType, samples:0, depthBuffer:false };
    this.rtA = new THREE.WebGLRenderTarget(1, 1, opts);
    this.rtB = new THREE.WebGLRenderTarget(1, 1, opts);
    this.fsQuad = new FullScreenQuad();

    // 1. bright pass: full-res in, quarter-res out
    this.bright = flareMat(
      { tDiffuse:{value:null}, uTexel:{value:new THREE.Vector2()}, uThreshold:{value:0.85} }, `
      uniform sampler2D tDiffuse; uniform vec2 uTexel; uniform float uThreshold;
      varying vec2 vUv;
      const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);       // Rec.709, linear space
      // Each tap is thresholded on its own, at full resolution, and only then
      // averaged. Thresholding the average instead throws the whole effect
      // away on this content: a preset is mostly one-pixel bright lines, and a
      // line averaged over a quarter-resolution texel lands far below any
      // threshold that the background does not also cross.
      vec3 tap(vec2 uv){
        vec3 c = min(max(texture2D(tDiffuse, uv).rgb, 0.0), vec3(64.0));   // bounded: feeds three more passes
        // a NaN would survive every blur below and smear across the frame
        if(!(c.r >= 0.0) || !(c.g >= 0.0) || !(c.b >= 0.0)) return vec3(0.0);
        float l = dot(c, LUMA);
        // Soft knee, so a pixel crossing the threshold fades in instead of
        // popping — then clamped to 1. Without the clamp the flare tracks raw
        // scene luminance, and the presets differ by several stops: the ones
        // that run hot blow the effect out at settings where the dim ones show
        // nothing. Clamping asks "how much of this pixel is over the line",
        // which is comparable across the set.
        return min(c * max(l - uThreshold, 0.0) / max(l, 1e-4), vec3(1.0));
      }
      void main(){
        // Four taps a texel apart rather than one: point-sampling thin lines
        // down to a quarter makes the flare crawl as they move between texels.
        // They are combined with max, not an average — a one-pixel line covers
        // a sixteenth of a quarter-resolution texel, and averaging hands back a
        // sixteenth of its brightness, which is most of this app's content
        // thrown away. The clamp above is what makes max safe.
        vec3 c = max(max(tap(vUv + uTexel), tap(vUv - uTexel)),
                     max(tap(vUv + vec2( uTexel.x, -uTexel.y)),
                         tap(vUv + vec2(-uTexel.x,  uTexel.y))));
        gl_FragColor = vec4(c, 1.0);
      }`);

    // 2. features: ghosts + streak, quarter-res throughout
    this.features = flareMat(
      { tBright:{value:null}, uTexel:{value:new THREE.Vector2()}, uAspect:{value:1},
        uDistortion:{value:0.005} }, `
      uniform sampler2D tBright; uniform vec2 uTexel; uniform float uAspect, uDistortion;
      varying vec2 vUv;
      const int GHOSTS = 4;                  // ghosts marching in from the mirrored point
      const int STREAK = 10;                 // streak taps per side
      const float DISPERSAL = 0.30;          // spacing of the ghosts along the centre line
      const float STREAK_SPREAD = 8.0;       // texels between streak taps
      // The R and B channels are sampled a little either side of G along the
      // flare's own axis: real ghosts are chromatically split, and without it
      // they read as grey smudges rather than lens artifacts.
      vec3 chroma(vec2 uv, vec2 dir){
        return vec3(texture2D(tBright, uv + dir*uDistortion).r,
                    texture2D(tBright, uv).g,
                    texture2D(tBright, uv - dir*uDistortion).b);
      }
      // 0 at the centre of frame, 1 at the corner — aspect-corrected, so the
      // ghosts stay circular on a wide window
      float radial(vec2 uv){
        return length((uv - 0.5) * vec2(uAspect, 1.0)) / length(vec2(0.5*uAspect, 0.5));
      }
      void main(){
        vec2 uv = vec2(1.0) - vUv;           // ghosts are the frame mirrored through its centre
        vec2 ghostVec = (vec2(0.5) - uv) * DISPERSAL;
        float glen = length(ghostVec);
        vec2 dir = glen > 1e-5 ? ghostVec/glen : vec2(0.0);   // undefined exactly at the centre
        vec3 flare = vec3(0.0);
        for(int i=0;i<GHOSTS;i++){
          vec2 off = uv + ghostVec*float(i);
          flare += chroma(off, dir) * pow(max(1.0 - radial(off), 0.0), 3.0);
        }
        // a lens is not colour-neutral: a soft cast that shifts with radius is
        // what separates a ghost from a dim copy of the scene
        flare *= 0.86 + 0.14*cos(6.2831853*(vec3(0.0, 0.33, 0.67) + radial(vUv)*0.9));
        // anamorphic streak — in screen space, not mirrored, so it sits on the
        // bright thing itself
        vec3 streak = vec3(0.0); float wsum = 0.0;
        for(int i=0;i<=2*STREAK;i++){
          float k = float(i - STREAK), f = k/float(STREAK), w = exp(-f*f*2.5);
          streak += texture2D(tBright, vUv + vec2(k*uTexel.x*STREAK_SPREAD, 0.0)).rgb * w;
          wsum += w;
        }
        // Gains, not physics. The streak is a normalised gaussian, so a line
        // spread over 21 taps keeps only a ninth of its peak and has to be
        // scaled back up; it is also the feature that carries the effect here,
        // because it sits *on* the bright thing. The ghosts are held far
        // lower: they are copies of the whole frame, and on presets that fill
        // it they stop reading as discrete artifacts and become a wash.
        gl_FragColor = vec4(flare*0.12 + streak/wsum * vec3(0.45, 0.70, 1.15) * 3.5, 1.0);
      }`);

    // 3. separable blur: the ghosts are copies of the scene until they are
    //    softened, and hard-edged copies read as a double exposure, not a lens
    this.blur = flareMat(
      { tDiffuse:{value:null}, uTexel:{value:new THREE.Vector2()}, uDir:{value:new THREE.Vector2()} }, `
      uniform sampler2D tDiffuse; uniform vec2 uTexel, uDir; varying vec2 vUv;
      void main(){
        vec2 s = uTexel * uDir;              // five bilinear taps ~ a nine-tap gaussian
        vec3 c = texture2D(tDiffuse, vUv).rgb * 0.227027;
        c += (texture2D(tDiffuse, vUv + s*1.3846).rgb + texture2D(tDiffuse, vUv - s*1.3846).rgb) * 0.316216;
        c += (texture2D(tDiffuse, vUv + s*3.2308).rgb + texture2D(tDiffuse, vUv - s*3.2308).rgb) * 0.070270;
        gl_FragColor = vec4(c, 1.0);
      }`);
  }
  get texture(){ return this.rtB.texture; }
  setSize(w, h){                             // called by the composer in drawing-buffer pixels
    const fw = Math.max(1, Math.round(w/FLARE_DIV)), fh = Math.max(1, Math.round(h/FLARE_DIV));
    this.rtA.setSize(fw, fh); this.rtB.setSize(fw, fh);
    this.bright.uniforms.uTexel.value.set(1/w, 1/h);        // reads the full-res frame
    this.features.uniforms.uTexel.value.set(1/fw, 1/fh);
    this.features.uniforms.uAspect.value = fw/fh;
    this.blur.uniforms.uTexel.value.set(1/fw, 1/fh);
  }
  render(renderer, writeBuffer, readBuffer){
    const draw = (mat, target) => {
      this.fsQuad.material = mat;
      renderer.setRenderTarget(target);
      this.fsQuad.render(renderer);
    };
    this.bright.uniforms.tDiffuse.value = readBuffer.texture;
    draw(this.bright, this.rtA);
    this.features.uniforms.tBright.value = this.rtA.texture;
    draw(this.features, this.rtB);
    this.blur.uniforms.tDiffuse.value = this.rtB.texture;
    this.blur.uniforms.uDir.value.set(1, 0);
    draw(this.blur, this.rtA);
    this.blur.uniforms.tDiffuse.value = this.rtA.texture;
    this.blur.uniforms.uDir.value.set(0, 1);
    draw(this.blur, this.rtB);               // the chain's own buffers are left untouched
  }
}
const flarePass = new FlarePass();
flarePass.enabled = false;
// The only full-resolution step: add the finished flare over the frame. Kept
// separate from the grade so it lands *under* the text overlay — the caption is
// meant to stay legible, not to be veiled by a lens artifact.
const flareComposite = new ShaderPass({
  uniforms: { tDiffuse:{value:null}, tFlare:{value:null}, uAmount:{value:0} },
  vertexShader: FLARE_VERT,
  fragmentShader: `
    uniform sampler2D tDiffuse, tFlare; uniform float uAmount; varying vec2 vUv;
    void main(){
      vec4 base = texture2D(tDiffuse, vUv);
      vec3 f = texture2D(tFlare, vUv).rgb * uAmount;
      // Soft roll-off, and the reason one slider can serve every preset: the
      // set spans several stops, so a gain that makes Spectrum Tunnel flare at
      // all blows Waveform out. Compressing the top end leaves the dim presets
      // very nearly linear and bounds the bright ones at 1/0.7.
      gl_FragColor = vec4(base.rgb + f/(1.0 + f*0.7), base.a);
    }`
});
// Bound after construction, not in the shader object above: ShaderPass clones
// the uniforms it is handed, and cloneUniforms() refuses to clone a render
// target's texture — it substitutes null and warns.
flareComposite.uniforms.tFlare.value = flarePass.texture;
flareComposite.enabled = false;

composer.addPass(renderPass);
composer.addPass(flarePass);                // reads the raw frame; writes only its own buffers
composer.addPass(bloomPass);
composer.addPass(flareComposite);
// The text overlay inserts itself here (see TEXT OVERLAY): after the bloom and
// the flare, so neither can reach the caption, and before the grade, so Color
// still applies to it along with everything else.
composer.addPass(gradePass);                // last: grades and encodes to sRGB
function sizeComposer(){
  composer.setSize(W, H);
  // Full drawing-buffer resolution for the bloom's mip chain: halving it is
  // cheaper, but on a thin bright trace the halo visibly bands and washes much
  // wider than it should, which is the opposite of what the glow is for. Only
  // very large buffers (4K, or HiDPI above 1440p) step down, and at that pixel
  // density the softer chain is far harder to see than the cost of a full one.
  const px = W*dpr * H*dpr, scale = px > 2.6e6 ? 0.7 : 1;
  bloomPass.setSize(W*dpr*scale, H*dpr*scale);
}
sizeComposer();
// true while any post pass has something to do; otherwise the scene goes
// straight to the canvas exactly as it did before the panel grew an Effects group
let fxActive = false;
function refreshFx(){
  bloomPass.enabled = state.glow > 0;
  flarePass.enabled = flareComposite.enabled = state.flare > 0;
  fxActive = bloomPass.enabled || flarePass.enabled || state.colour !== 1;
}

/* =========================================================================
   MOVEMENT  —  a slow random drift laid over whatever the preset animates.
   Six channels (rotation xyz + sway xyz) random-walk toward fresh targets and
   are eased toward them, so the extra motion reads as a wander, never a jump.
   Targets are re-rolled on a timer and kicked on strong onsets. Both the
   amplitude and the drift rate scale with the slider: 0 is perfectly still,
   100 is a wide, restless orbit.
   ========================================================================= */
const MOVE_ROT = [0.30, 0.46, 0.22];        // max yaw/pitch/roll (radians) at 100%
const MOVE_SWAY = 0.07;                     // max sway as a fraction of camera distance
const wander = { cur:new Float32Array(6), tgt:new Float32Array(6), next:0, prevBeat:0 };
function reroll(){
  for(let i=0;i<6;i++) wander.tgt[i] = Math.random()*2 - 1;
  wander.next = 1.8 + Math.random()*3.4;    // seconds until the next re-roll
}
reroll();
function updateWander(dt, A){
  const amt = state.movement;
  wander.next -= dt * (0.6 + amt*0.9);
  const kick = A.beat > 0.7 && wander.prevBeat <= 0.7;   // rising edge only
  wander.prevBeat = A.beat;
  if(wander.next <= 0 || kick) reroll();
  const rate = ease(dt, 0.35 + amt*0.85);
  for(let i=0;i<6;i++) wander.cur[i] += (wander.tgt[i] - wander.cur[i]) * rate;
}
// The drag orbit and the movement drift are summed into the preset's content
// root, so both compose with the preset's own camera/group motion
// instead of fighting it. The root is fully reassigned every frame, so nothing
// accumulates and a slider at 0 leaves the preset exactly as authored.
function applyView(p){
  const a = state.movement * MOTION, c = wander.cur, o = state.orbit;
  p.root.rotation.set(o.x + c[0]*MOVE_ROT[0]*a, o.y + c[1]*MOVE_ROT[1]*a, c[2]*MOVE_ROT[2]*a);
  // sway is scaled by how far the camera sits from the origin, so one slider
  // reads the same across presets whose worlds differ in size by 100x
  const k = Math.max(p.camera.position.length(), 0.5) * MOVE_SWAY * a;
  p.root.position.set(c[3]*k, c[4]*k, c[5]*k);
}

/* =========================================================================
   AUDIO ENGINE  —  dB level + FFT bands + spectral-flux onset detection
   ========================================================================= */
const BARS = 64;                     // downsampled spectrum resolution for visuals
const WAVE = 512;                    // downsampled time-domain waveform for the oscilloscope trace
const Audio = {
  ctx:null, analyser:null, gain:null,
  freq:null, timeF:null, prevSpec:null,
  el:null, fileSrc:null, micSrc:null, micStream:null,
  // published, smoothed values read by presets + UI
  level:0, levelDb:-100, beat:0, beatRaw:0, low:0, mid:0, high:0, time:0, opacity:1,
  spectrum:new Float32Array(BARS),
  wave:new Float32Array(WAVE), wavePeak:0,
  // onset internals
  fluxHist:[], lastBeat:0, sensitivity:1.3, beatTimes:[], bpm:0,
  peakLevel:0
};

// frame-rate independent exponential smoothing: same feel at 30 or 144 fps
const ease = (dt, rate) => 1 - Math.exp(-dt*rate);

function ensureCtx(){
  if (Audio.ctx) return;
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0.75;
  Object.assign(Audio, {
    ctx, analyser,
    freq:new Uint8Array(analyser.frequencyBinCount),
    timeF:new Float32Array(analyser.fftSize),
    prevSpec:new Float32Array(analyser.frequencyBinCount)
  });
}

// request mic + start analysing. Mic is NOT routed to output (no feedback).
async function startMic(){
  ensureCtx();
  setMicStatus('requesting');
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio:{ echoCancellation:false, noiseSuppression:false, autoGainControl:false } });
  } catch(err){
    setMicStatus(err && err.name==='NotAllowedError' ? 'blocked' : 'error');
    return;
  }
  try { Audio.micSrc && Audio.micSrc.disconnect(); } catch(e){}
  Audio.micStream = stream;
  Audio.micSrc = Audio.ctx.createMediaStreamSource(stream);
  Audio.micSrc.connect(Audio.analyser);   // analyser only — never to destination
  await Audio.ctx.resume();
  if (Audio.ctx.state !== 'running') armResume();   // autoplay policy may need a gesture
  setMicStatus();
}

function stopMic(){
  try { Audio.micSrc && Audio.micSrc.disconnect(); } catch(e){}
  if (Audio.micStream){ Audio.micStream.getTracks().forEach(t=>t.stop()); Audio.micStream=null; }
  Audio.micSrc = null;
  setMicStatus('stopped');
}

// per-frame analysis
function analyse(dt){
  const a = Audio;
  if (!a.analyser){ a.level*=0.9; a.beat*=Math.exp(-dt*8); publishIdle(); return; }
  a.analyser.getByteFrequencyData(a.freq);
  a.analyser.getFloatTimeDomainData(a.timeF);

  // --- RMS level + dB ---
  let sum=0; for (let i=0;i<a.timeF.length;i++){ const v=a.timeF[i]; sum+=v*v; }
  const rms = Math.sqrt(sum/a.timeF.length);
  const db = rms>1e-6 ? 20*Math.log10(rms) : -100;
  a.levelDb = db;
  const norm = Math.min(1, Math.max(0, (db+60)/60));   // -60..0 dB -> 0..1
  // gentle attack/release (photosensitivity-safe: no snap changes)
  a.level += (norm - a.level) * (norm>a.level ? 0.25 : 0.08);
  // dB-driven opacity: raised floor + reduced range so the whole field never
  // swings dark↔bright fast; extra low-pass keeps it from flickering
  const opFloor = REDUCED_MOTION ? 0.6 : 0.4, opSpan = REDUCED_MOTION ? 0.4 : 0.6;
  a.opacity += (opFloor + a.level*opSpan - a.opacity) * 0.12;
  a.peakLevel = Math.max(a.peakLevel*0.985, a.level);

  // --- time-domain waveform, oscilloscope style ---
  const tf = a.timeF, tlen = tf.length;
  let rp = 0; for (let i=0;i<tlen;i++){ const v = Math.abs(tf[i]); if (v>rp) rp = v; }
  a.wavePeak += (rp - a.wavePeak) * ease(dt, rp>a.wavePeak ? 18 : 1.5);

  // Armed edge trigger (fires on a rise past +thr only after dipping below
  // -thr) so a steady tone draws a steady trace instead of sliding sideways
  // every frame; the threshold tracks the signal so noise can't trigger it.
  const thr = Math.max(0.006, a.wavePeak*0.3);
  let start = 0, armed = false;
  for (let i=0;i<tlen>>2;i++){
    const v = tf[i];
    if (!armed){ if (v < -thr) armed = true; }
    else if (v > thr){ start = i; break; }
  }

  // Box-filtered downsample of a ~21 ms window — averaging each bucket instead
  // of point-sampling it removes the aliasing that made the curve look jagged,
  // and the short window keeps individual cycles readable rather than packed.
  const bucket = Math.min(tlen - start, tlen*0.5)/WAVE;
  const wk = ease(dt, REDUCED_MOTION ? 14 : 34);   // light: the trace must stay live
  for (let i=0;i<WAVE;i++){
    const i0 = start + Math.floor(i*bucket);
    const i1 = Math.max(i0+1, start + Math.floor((i+1)*bucket));
    let acc = 0; for (let j=i0;j<i1;j++) acc += tf[j];
    a.wave[i] += (acc/(i1-i0) - a.wave[i]) * wk;
  }

  // --- bands ---
  const sr = a.ctx.sampleRate, n = a.freq.length, ny = sr/2;
  const binOf = f => Math.min(n-1, Math.floor(f/ny*n));
  const avg = (f0,f1)=>{ let s=0,c=0; for(let i=binOf(f0);i<=binOf(f1);i++){s+=a.freq[i];c++;} return c?s/c/255:0; };
  const low=avg(20,250), mid=avg(250,2000), high=avg(2000,8000);
  a.low  += (low  - a.low )*0.25;
  a.mid  += (mid  - a.mid )*0.25;
  a.high += (high - a.high)*0.25;

  // --- downsampled spectrum (log-ish) with peak-decay for falling bars ---
  const usable = Math.floor(n*0.72);
  for (let b=0;b<BARS;b++){
    const i0 = Math.floor(Math.pow(b/BARS,1.8)*usable);
    const i1 = Math.max(i0+1, Math.floor(Math.pow((b+1)/BARS,1.8)*usable));
    let s=0; for(let i=i0;i<i1;i++) s+=a.freq[i];
    const t = s/((i1-i0)*255);
    a.spectrum[b] = t>a.spectrum[b] ? a.spectrum[b] + (t-a.spectrum[b])*0.5 : a.spectrum[b]*0.9;
  }

  // --- spectral-flux onset detection ---
  let flux=0;
  for (let i=0;i<n;i++){ const d=a.freq[i]-a.prevSpec[i]; if(d>0) flux+=d; a.prevSpec[i]=a.freq[i]; }
  flux/=n;
  a.fluxHist.push(flux); if (a.fluxHist.length>50) a.fluxHist.shift();
  let m=0; for(const f of a.fluxHist) m+=f; m/=a.fluxHist.length;
  const thresh = m*a.sensitivity + 0.6;
  const now = a.ctx.currentTime;
  if (flux>thresh && (now-a.lastBeat)>0.11 && a.level>0.05){
    a.beatRaw = 1;
    if (a.lastBeat){ a.beatTimes.push(now-a.lastBeat); if(a.beatTimes.length>12) a.beatTimes.shift(); }
    a.lastBeat = now;
    const med = [...a.beatTimes].sort((x,y)=>x-y)[Math.floor(a.beatTimes.length/2)];
    if (med) a.bpm = Math.round(60/med);
  }
  // photosensitivity-safe pulse: raw onset decays slowly, and the value presets
  // read (a.beat) rises with a slew limit so onsets become swells, not flashes
  a.beatRaw *= Math.exp(-dt*3.2);
  a.beat += (a.beatRaw*MOTION - a.beat) * Math.min(1, dt*7);
  a.time += dt;
}
function publishIdle(){}

/* =========================================================================
   PRESETS  —  each owns a scene + camera, exposes update(dt, A)
   ========================================================================= */
const NOISE = `
vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 mod289(vec4 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 permute(vec4 x){return mod289(((x*34.0)+1.0)*x);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-0.85373472095314*r;}
float snoise(vec3 v){
  const vec2 C=vec2(1.0/6.0,1.0/3.0); const vec4 D=vec4(0.0,0.5,1.0,2.0);
  vec3 i=floor(v+dot(v,C.yyy)); vec3 x0=v-i+dot(i,C.xxx);
  vec3 g=step(x0.yzx,x0.xyz); vec3 l=1.0-g; vec3 i1=min(g.xyz,l.zxy); vec3 i2=max(g.xyz,l.zxy);
  vec3 x1=x0-i1+C.xxx; vec3 x2=x0-i2+C.yyy; vec3 x3=x0-D.yyy;
  i=mod289(i);
  vec4 p=permute(permute(permute(i.z+vec4(0.0,i1.z,i2.z,1.0))+i.y+vec4(0.0,i1.y,i2.y,1.0))+i.x+vec4(0.0,i1.x,i2.x,1.0));
  float ns_=0.142857142857; vec3 ns=ns_*D.wyz-D.xzx;
  vec4 j=p-49.0*floor(p*ns.z*ns.z);
  vec4 x_=floor(j*ns.z); vec4 y_=floor(j-7.0*x_);
  vec4 x=x_*ns.x+ns.yyyy; vec4 y=y_*ns.x+ns.yyyy; vec4 h=1.0-abs(x)-abs(y);
  vec4 b0=vec4(x.xy,y.xy); vec4 b1=vec4(x.zw,y.zw);
  vec4 s0=floor(b0)*2.0+1.0; vec4 s1=floor(b1)*2.0+1.0; vec4 sh=-step(h,vec4(0.0));
  vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy; vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
  vec3 p0=vec3(a0.xy,h.x); vec3 p1=vec3(a0.zw,h.y); vec3 p2=vec3(a1.xy,h.z); vec3 p3=vec3(a1.zw,h.w);
  vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
  p0*=norm.x;p1*=norm.y;p2*=norm.z;p3*=norm.w;
  vec4 mv=max(0.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.0); mv*=mv;
  return 42.0*dot(mv*mv,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
}`;

const dummy = new THREE.Object3D();
const col = new THREE.Color();
const presets = [];

/* --- 1. SPECTRUM TUNNEL : fly through rings of the live spectrum --- */
function makeTunnel(){
  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0x0b0c10, 6, 34);
  const camera = new THREE.PerspectiveCamera(70, W/H, 0.1, 100); camera.position.set(0,0,0.1);
  const RINGS=44, SEG=72, DEPTH=36, baseR=3.4;
  const grp = new THREE.Group(); scene.add(grp);
  const rings=[];
  for(let i=0;i<RINGS;i++){
    const g=new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(SEG*3),3));
    const m=new THREE.LineBasicMaterial({ transparent:true });
    const loop=new THREE.LineLoop(g,m);
    rings.push({ mesh:loop, z:-(i/RINGS)*DEPTH, prof:new Float32Array(SEG), hue:0.6 });
    grp.add(loop);
  }
  function reseed(ring,A){ for(let j=0;j<SEG;j++) ring.prof[j]=A.spectrum[Math.floor(j/SEG*BARS)%BARS]; ring.hue=(A.time*0.05)%1; }
  function shape(ring){
    const pos=ring.mesh.geometry.attributes.position.array, twist=ring.z*0.15;
    for(let j=0;j<SEG;j++){
      const a=j/SEG*Math.PI*2+twist, r=baseR+ring.prof[j]*3.4;
      pos[j*3]=Math.cos(a)*r; pos[j*3+1]=Math.sin(a)*r; pos[j*3+2]=ring.z;
    }
    ring.mesh.geometry.attributes.position.needsUpdate=true;
  }
  presets.push({
    name:'Spectrum Tunnel', desc:'flythrough · spectrum rings', scene, camera,
    resize(){ camera.aspect=W/H; camera.updateProjectionMatrix(); },
    update(dt,A){
      const speed=(6 + A.level*20 + A.beat*10)*dt;
      for(const ring of rings){
        ring.z += speed;
        if(ring.z>1.5){ ring.z-=DEPTH; reseed(ring,A); }
        shape(ring);
        const depth=1-(-ring.z)/DEPTH;
        col.setHSL((ring.hue+0.55)%1, 0.7, 0.22+depth*0.5+A.beat*0.12);
        ring.mesh.material.color.copy(col);
        ring.mesh.material.opacity=A.opacity;
      }
      grp.rotation.z += dt*(0.05 + A.level*0.35);
    }
  });
}

/* --- 2. RADIAL SPECTRUM BURST : mirrored circular equalizer --- */
function makeRadial(){
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, W/H, 0.1, 100); camera.position.set(0,0,16);
  const N = BARS*2, r0 = 3.4;
  const geo = new THREE.BoxGeometry(0.13, 1, 0.13); geo.translate(0,0.5,0);
  const mat = new THREE.MeshBasicMaterial({ transparent:true });
  const mesh = new THREE.InstancedMesh(geo, mat, N);
  mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(N*3), 3);
  const grp = new THREE.Group(); grp.add(mesh); scene.add(grp);
  const core = new THREE.Mesh(new THREE.CircleGeometry(r0*0.82, 64),
    new THREE.MeshBasicMaterial({ color:0x0e1016, transparent:true }));
  grp.add(core);
  presets.push({
    name:'Radial Spectrum Burst', desc:'mirrored ring · onset flare', scene, camera,
    resize(){ camera.aspect=W/H; camera.updateProjectionMatrix(); },
    update(dt,A){
      grp.rotation.z += dt*(0.1 + A.level*0.4);
      const flare = 1 + A.beat*0.35;
      for (let i=0;i<N;i++){
        const b = i<BARS ? i : (N-1-i);          // mirror
        const s = A.spectrum[b];
        const ang = i/N*Math.PI*2;
        const len = (0.3 + s*7 + A.beat*1.2*s)*flare;
        const rr = r0*flare;
        dummy.position.set(Math.cos(ang)*rr, Math.sin(ang)*rr, 0);
        dummy.rotation.set(0,0, ang - Math.PI/2);
        dummy.scale.set(1, len, 1);
        dummy.updateMatrix(); mesh.setMatrixAt(i, dummy.matrix);
        col.setHSL((0.02 + s*0.14 + A.time*0.02)%1, 0.85, 0.45 + s*0.3 + A.beat*0.15);
        mesh.setColorAt(i, col);
      }
      mesh.instanceMatrix.needsUpdate=true; mesh.instanceColor.needsUpdate=true;
      mat.opacity = A.opacity; core.material.opacity = A.opacity;
    }
  });
}

/* --- 3. FREQUENCY TERRAIN : scrolling spectrogram landscape (wireframe) --- */
function makeTerrain(){
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(55, W/H, 0.1, 200);
  camera.position.set(0,7,15);
  const COLS=BARS, ROWS=90, width=26, depth=42;
  const heights=new Float32Array(ROWS*COLS);
  const pos=new Float32Array(ROWS*COLS*3), colr=new Float32Array(ROWS*COLS*3);
  for(let r=0;r<ROWS;r++)for(let c=0;c<COLS;c++){
    const i=r*COLS+c;
    pos[i*3]=(c/(COLS-1)-0.5)*width; pos[i*3+1]=0; pos[i*3+2]=-(r/(ROWS-1))*depth;
  }
  const idx=[];
  for(let r=0;r<ROWS-1;r++)for(let c=0;c<COLS-1;c++){
    const a=r*COLS+c, b=a+1, d=a+COLS, e=d+1; idx.push(a,b,d, b,e,d);
  }
  const g=new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos,3));
  g.setAttribute('color', new THREE.BufferAttribute(colr,3));
  g.setIndex(idx);
  const mat=new THREE.MeshBasicMaterial({ wireframe:true, vertexColors:true, transparent:true });
  const mesh=new THREE.Mesh(g,mat); scene.add(mesh);
  presets.push({
    name:'Frequency Terrain', desc:'scrolling spectrogram landscape', scene, camera,
    resize(){ camera.aspect=W/H; camera.updateProjectionMatrix(); },
    update(dt,A){
      heights.copyWithin(COLS, 0, (ROWS-1)*COLS);       // scroll rows toward the back
      for(let c=0;c<COLS;c++) heights[c]=A.spectrum[c];  // newest spectrum at the front
      for(let r=0;r<ROWS;r++)for(let c=0;c<COLS;c++){
        const i=r*COLS+c, h=heights[i];
        pos[i*3+1]=h*8;
        col.setHSL((0.62-h*0.5+A.time*0.02)%1, 0.75, 0.28+h*0.45+A.beat*0.08);
        colr[i*3]=col.r; colr[i*3+1]=col.g; colr[i*3+2]=col.b;
      }
      g.attributes.position.needsUpdate=true; g.attributes.color.needsUpdate=true;
      mat.opacity=A.opacity;
      camera.position.y=7+Math.sin(A.time*0.3)*0.6+A.beat*0.5;
      camera.lookAt(0,1.5,-depth*0.35);
    }
  });
}

/* --- 4. WAVEFORM : real-time oscilloscope trace with additive glow --- */
function makeWaveform(){
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, W/H, 0.1, 100); camera.position.set(0,0,9);
  const P = WAVE;
  let width = 18, halfH = 4;                 // world size of the viewport, set by fit()

  // A polyline stroked as a triangle strip: three verts per sample (top /
  // centre / bottom) pushed along the local curve normal, so thickness stays
  // even through steep slopes AND each pass can fade from a bright centre to
  // transparent edges. Stacking a few passes (wide+dim -> thin+bright) builds
  // the glow additively, far cheaper than a full bloom post-pass.
  function makeStroke(){
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(P*3*3), 3));
    g.setAttribute('color',    new THREE.BufferAttribute(new Float32Array(P*3*3), 3));
    const idx = [];
    for(let i=0;i<P-1;i++){
      const t0=i*3, m0=t0+1, b0=t0+2, t1=t0+3, m1=t1+1, b1=t1+2;
      idx.push(t0,m0,t1, m0,m1,t1, m0,b0,m1, b0,b1,m1);
    }
    g.setIndex(idx);
    const m = new THREE.MeshBasicMaterial({
      vertexColors:true, transparent:true, depthWrite:false,
      blending:THREE.AdditiveBlending, side:THREE.DoubleSide
    });
    const mesh = new THREE.Mesh(g, m); mesh.frustumCulled = false; scene.add(mesh);
    return { g, m, mesh, pos:g.attributes.position.array, colr:g.attributes.color.array };
  }
  // Widest/faintest first, so the bright core lands on top.
  // `edge` is how much colour survives at the outer edge (0 = soft halo,
  // 1 = solid line). `miter` blends the offset direction between straight up
  // (0) and the true curve normal (1): a wide pass offset along the normal
  // self-intersects at tight bends and throws off visible fans, so only the
  // thin core — where the offset stays well inside the turn radius — miters.
  const layers = [
    { s:makeStroke(), thick:22,  gain:0.10, light:0.42, edge:0.00, miter:0.0 },  // outer bloom
    { s:makeStroke(), thick: 9,  gain:0.16, light:0.48, edge:0.00, miter:0.0 },  // halo
    { s:makeStroke(), thick: 3.4,gain:0.34, light:0.56, edge:0.15, miter:0.45 }, // inner glow
    { s:makeStroke(), thick: 1,  gain:0.95, light:0.70, edge:0.85, miter:1.0 }   // core hairline
  ];
  layers.forEach((l,i)=>{ l.s.mesh.renderOrder = i+1; });   // core paints last

  // dim centre axis so the trace still reads as a line when the room is silent
  const axisG = new THREE.BufferGeometry();
  axisG.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-9,0,-0.01, 9,0,-0.01]), 3));
  const axis = new THREE.Line(axisG, new THREE.LineBasicMaterial({ color:0x2a4a63, transparent:true }));
  scene.add(axis);

  const xs = new Float32Array(P), ys = new Float32Array(P), sm = new Float32Array(P);
  let sDrive = 0, sHue = 0.52;                // eased envelopes, never stepped per frame

  function fit(){
    camera.aspect = W/H; camera.updateProjectionMatrix();
    const vh = 2*Math.tan(camera.fov*Math.PI/360)*camera.position.z;
    halfH = vh/2;
    width = vh*camera.aspect*1.04;            // slight overscan so the ends run off-screen
    const ap = axisG.attributes.position.array;
    ap[0] = -width/2; ap[3] = width/2;
    axisG.attributes.position.needsUpdate = true;
  }
  fit();

  function stroke(L, th, hue, lightSpan, opacity){
    const { pos, colr } = L.s;
    const edge = L.edge, mi = L.miter;
    for(let i=0;i<P;i++){
      const p0 = Math.max(0,i-1), p1 = Math.min(P-1,i+1);
      const tx = xs[p1]-xs[p0], ty = ys[p1]-ys[p0];
      const len = Math.hypot(tx,ty) || 1;
      // blend the curve normal toward vertical; x is monotonic so the normal
      // never flips and the blend stays well conditioned
      const dx = -ty/len*mi, dy = (tx/len)*mi + (1-mi);
      const dl = Math.hypot(dx,dy) || 1;
      const nx = dx/dl*th, ny = dy/dl*th;
      const k = i*9, x = xs[i], y = ys[i];
      pos[k]  =x+nx; pos[k+1]=y+ny; pos[k+2]=0;   // top edge
      pos[k+3]=x;    pos[k+4]=y;    pos[k+5]=0;   // centre
      pos[k+6]=x-nx; pos[k+7]=y-ny; pos[k+8]=0;   // bottom edge
      // taper both ends so the trace fades out instead of stopping dead
      const e = i/(P-1), t = Math.min(1, Math.min(e,1-e)/0.10);
      const f = t*t*(3-2*t)*opacity, fe = f*edge;
      col.setHSL(hue, 0.75, L.light + Math.min(1, Math.abs(y)/halfH*2.2)*lightSpan);
      colr[k]  =col.r*fe; colr[k+1]=col.g*fe; colr[k+2]=col.b*fe;
      colr[k+3]=col.r*f;  colr[k+4]=col.g*f;  colr[k+5]=col.b*f;
      colr[k+6]=col.r*fe; colr[k+7]=col.g*fe; colr[k+8]=col.b*fe;
    }
    L.s.g.attributes.position.needsUpdate = true;
    L.s.g.attributes.color.needsUpdate = true;
  }

  presets.push({
    name:'Waveform', desc:'live oscilloscope trace · glow', scene, camera,
    resize: fit,
    update(dt,A){
      // height follows the input level: silence sits near flat, loud fills the
      // frame — eased so the trace grows and settles instead of snapping
      sDrive += (Math.min(1, A.level*1.5) - sDrive) * ease(dt, 6);
      const norm = 1/Math.max(A.wavePeak, 0.02);   // mic samples sit far below full scale
      const amp  = halfH*(0.05 + sDrive*0.70 + A.beat*0.05*MOTION);

      // tanh soft-limits instead of clipping, so a peak louder than the tracked
      // average compresses into the frame with its shape intact
      for(let i=0;i<P;i++) sm[i] = Math.tanh(A.wave[i]*norm*0.85)*1.15;
      // 1-2-1 pass over the samples: rounds the polyline without dulling the shape
      for(let i=0;i<P;i++){
        const a0 = sm[Math.max(0,i-1)], b0 = sm[Math.min(P-1,i+1)];
        xs[i] = (i/(P-1)-0.5)*width;
        ys[i] = (a0 + sm[i]*2 + b0) * 0.25 * amp;
      }

      // hue drifts slowly and warms with level; glow swells on onsets
      sHue += (0.52 - sDrive*0.09 - sHue) * ease(dt, 2);
      const hue  = (sHue + A.time*0.012) % 1;
      const base = halfH*(0.006 + sDrive*0.006);
      const glow = 1 + A.level*0.5 + A.beat*0.6*MOTION;
      for(const L of layers) stroke(L, base*L.thick, hue, 0.20, L.gain*glow*A.opacity);

      axis.material.opacity = 0.10 + (1-sDrive)*0.20;
    }
  });
}

/* --- 5. STARFIELD WARP : hyperspace streaks that surge on onsets --- */
function makeStarfield(){
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(75, W/H, 0.1, 100); camera.position.set(0,0,0.1);
  const N=1400, DEPTH=40, spread=22;
  const pos=new Float32Array(N*2*3), colr=new Float32Array(N*2*3);
  const star=[];
  function seed(i,z){ star[i]={ x:(Math.random()*2-1)*spread, y:(Math.random()*2-1)*spread, z }; }
  for(let i=0;i<N;i++) seed(i, -Math.random()*DEPTH);
  const g=new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos,3));
  g.setAttribute('color', new THREE.BufferAttribute(colr,3));
  const mat=new THREE.LineBasicMaterial({ vertexColors:true, transparent:true, blending:THREE.AdditiveBlending, depthWrite:false });
  const lines=new THREE.LineSegments(g,mat); scene.add(lines);
  presets.push({
    name:'Starfield Warp', desc:'hyperspace · beat bursts', scene, camera,
    resize(){ camera.aspect=W/H; camera.updateProjectionMatrix(); },
    update(dt,A){
      const speed=(8+A.level*28+A.beat*36)*dt, streak=0.4+A.level*2.5+A.beat*4;
      for(let i=0;i<N;i++){
        const s=star[i]; s.z+=speed;
        if(s.z>1) seed(i,-DEPTH);
        const k=i*6, hz=star[i].z, tz=star[i].z-streak;
        pos[k]=star[i].x; pos[k+1]=star[i].y; pos[k+2]=hz;
        pos[k+3]=star[i].x; pos[k+4]=star[i].y; pos[k+5]=tz;
        const depth=1-(-star[i].z)/DEPTH;
        col.setHSL((0.58+A.beat*0.12)%1, 0.5, 0.25+depth*0.6);
        colr[k]=col.r; colr[k+1]=col.g; colr[k+2]=col.b;             // bright head
        colr[k+3]=col.r*0.08; colr[k+4]=col.g*0.08; colr[k+5]=col.b*0.08; // faded tail
      }
      g.attributes.position.needsUpdate=true; g.attributes.color.needsUpdate=true;
      mat.opacity=A.opacity;
      lines.rotation.z += dt*0.05;
    }
  });
}

/* --- 6. LIQUID WAVES : black silk sheet, anisotropic sheen, slow folds --- */
function makeSilk(){
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, W/H, 0.1, 200); camera.position.set(0,16,17);
  camera.lookAt(0,0,-3);

  const uniforms = {
    uTime:{value:0}, uAmp:{value:0.8}, uLevel:{value:0}, uBeat:{value:0},
    uLow:{value:0}, uMid:{value:0}, uHigh:{value:0}, uOpacity:{value:1}, uLightPhase:{value:0}
  };

  // the sheet lies in the XZ plane; folds displace it along Y
  const geo = new THREE.PlaneGeometry(66, 66, 320, 220);
  const mat = new THREE.ShaderMaterial({
    uniforms, transparent:true, side:THREE.DoubleSide,
    vertexShader: NOISE + `
      uniform float uTime, uAmp, uLow, uMid, uHigh, uBeat;
      varying vec3 vWorld; varying vec3 vN; varying vec3 vT; varying vec2 vUv;

      // waves roll toward the viewer as long parallel ridges: noise squashed on x
      // makes features stretch across the sheet, which is what breaks the sheen into
      // thin fabric-like streaks instead of round blobs
      float folds(vec2 p){
        float t = uTime;
        float scroll = t * 1.6;
        vec2 q = vec2(p.x*0.28, p.y + scroll);
        float h  = snoise(vec3(q*0.145,        t*0.06)) * 1.15;
        h += snoise(vec3(q*0.340 + 17.0, t*0.10)) * 0.42 * (0.60 + uLow*1.3);
        h += snoise(vec3(q*0.800 + 31.0, t*0.16)) * 0.08 * (0.50 + uMid*1.2);
        // fine weave ripples across the drape — the detail that makes it read as cloth
        h += sin((p.y+scroll)*1.90 + snoise(vec3(p*0.05, t*0.10))*2.6) * 0.085 * (0.55 + uHigh*1.3);
        h += sin((p.y+scroll)*4.40 + snoise(vec3(p*0.09, t*0.14))*3.4) * 0.018;
        float d = length(p);                       // onset ripple leaving the centre
        h += uBeat * 0.45 * sin(d*0.45 - t*3.0) * exp(-d*0.045);
        return h * uAmp;
      }

      void main(){
        vUv = uv;
        vec2 p = position.xy;
        float e = 0.30;                            // finite-difference step for normals
        float h  = folds(p);
        float hx = folds(p + vec2(e,0.0));
        float hy = folds(p + vec2(0.0,e));
        vec3 T = normalize(vec3(e, 0.0, hx-h));    // weave direction, drives the anisotropy
        vec3 B = normalize(vec3(0.0, e, hy-h));
        vec3 N = normalize(cross(T,B));
        vec4 wp = modelMatrix * vec4(position.xy, h, 1.0);
        vWorld = wp.xyz;
        vN = normalize(normalMatrix * N);
        vT = normalize(normalMatrix * T);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: `
      uniform float uLevel, uBeat, uOpacity, uLightPhase;
      varying vec3 vWorld; varying vec3 vN; varying vec3 vT; varying vec2 vUv;

      // Kajiya-Kay: highlight stretched along the thread, not a round plastic dot
      float sheen(vec3 T, vec3 L, vec3 V, float e){
        float tl = dot(T,L), tv = dot(T,V);
        return pow(max(sqrt(1.0-tl*tl)*sqrt(1.0-tv*tv) - tl*tv, 0.0), e);
      }

      void main(){
        vec3 N = normalize(vN);
        if(!gl_FrontFacing) N = -N;
        vec3 T = normalize(vT);
        vec3 V = normalize(cameraPosition - vWorld);

        vec3 L1 = normalize(vec3(sin(uLightPhase)*0.85, 0.70, cos(uLightPhase)*0.85)); // key, drifting
        vec3 L2 = normalize(vec3(-0.80, 0.45, -0.75));                                 // cool back rim

        float ndl = max(dot(N,L1), 0.0);
        float lit = smoothstep(0.05, 0.45, ndl);      // keep the far side of every fold black
        vec3 c = vec3(0.0022,0.0026,0.0040) * (0.25 + 0.75*ndl);

        float g1 = pow(max(dot(N, normalize(L1+V)), 0.0), 260.0);   // tight wet glint
        float g2 = pow(max(dot(N, normalize(L2+V)), 0.0), 120.0);
        float a1 = sheen(T, L1, V, 150.0) * lit;                    // narrow ribbon along the folds
        float a2 = sheen(T, L2, V, 70.0);
        float fres = pow(max(1.0 - max(dot(N,V), 0.0), 0.0), 6.0);

        float glint = 1.0 + uBeat*0.8;                              // onset lifts the shine
        c += vec3(0.85,0.90,1.00) * g1 * 1.10 * glint;
        c += vec3(0.26,0.58,0.66) * g2 * 0.10;
        // broad satin band, plus a tight near-white core along its crest — the band alone
        // reads soft and chalky, the core is what makes it look wet and shiny
        c += vec3(0.62,0.70,0.86) * a1 * 0.20 * (0.60 + uLevel*1.1);
        c += vec3(0.96,0.98,1.00) * pow(a1,5.0) * 0.60 * glint;
        c += vec3(0.30,0.78,0.86) * a2 * 0.05 * lit;
        c += vec3(0.26,0.24,0.42) * fres * (0.045 + uLevel*0.09 + uBeat*0.04);

        c = c / (1.0 + c);                                      // soft highlight rolloff

        // dissolve the sheet's borders into the background instead of cutting them off
        float edge = smoothstep(0.0,0.10,vUv.x) * smoothstep(1.0,0.90,vUv.x)
                   * smoothstep(0.0,0.06,vUv.y) * smoothstep(1.0,0.68,vUv.y);
        gl_FragColor = vec4(c, uOpacity * edge);
        #include <colorspace_fragment>
      }`
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.x = -Math.PI/2; mesh.position.z = -2;
  scene.add(mesh);

  let t = 0, phase = 0;
  presets.push({
    name:'Liquid Waves', desc:'black silk · anisotropic sheen', scene, camera,
    resize(){ camera.aspect=W/H; camera.updateProjectionMatrix(); },
    update(dt,A){
      // the drape flows faster when it is loud, but never snaps
      t += dt * MOTION * (0.55 + A.level*0.9 + A.beat*0.35);
      phase += dt * MOTION * 0.16;
      uniforms.uTime.value = t;
      uniforms.uLightPhase.value = phase;
      uniforms.uAmp.value += ((0.55 + A.level*1.35 + A.low*0.55) - uniforms.uAmp.value) * Math.min(1, dt*3);
      uniforms.uLevel.value = A.level; uniforms.uBeat.value = A.beat;
      uniforms.uLow.value = A.low; uniforms.uMid.value = A.mid; uniforms.uHigh.value = A.high;
      uniforms.uOpacity.value = A.opacity;
      camera.position.y = 16 + Math.sin(t*0.25)*0.8 + A.beat*0.6;
      camera.lookAt(0,0,-3);
    }
  });
}
/* --- 7. SPHERE : wire-mesh globe, glowing edges, spectral relief --- */
function makeSphere(){
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, W/H, 0.1, 100); camera.position.set(0,0,9);

  // An icosphere: near-uniform triangles, so the visible mesh reads as an even
  // weave instead of pinching at the poles the way a lat/long sphere does.
  const geo = new THREE.IcosahedronGeometry(1, 8);   // 1620 faces: dense enough to
  // carry the relief, coarse enough that every edge still reads as its own line
  geo.deleteAttribute('uv'); geo.deleteAttribute('normal');
  // Barycentric coordinates per triangle: the fragment shader derives the
  // wireframe from them, which gives anti-aliased, thickness-controlled,
  // glowing edges — `wireframe:true` can only draw hard 1px lines.
  const vcount = geo.attributes.position.count;
  const bary = new Float32Array(vcount*3);
  for(let i=0;i<vcount;i+=3){ bary[i*3]=1; bary[(i+1)*3+1]=1; bary[(i+2)*3+2]=1; }
  geo.setAttribute('aBary', new THREE.BufferAttribute(bary,3));

  // live spectrum as a 1-D texture: latitude samples it, so each band of the
  // globe is driven by its own slice of the FFT (equator = lows, poles = highs)
  const specData = new Uint8Array(BARS*4);
  const specTex = new THREE.DataTexture(specData, BARS, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
  specTex.minFilter = specTex.magFilter = THREE.LinearFilter;   // interpolate between bins
  specTex.wrapS = specTex.wrapT = THREE.ClampToEdgeWrapping;
  specTex.generateMipmaps = false; specTex.needsUpdate = true;

  const U = {
    uAmp:{value:0.10}, uLow:{value:0}, uMid:{value:0}, uHigh:{value:0},
    uBeat:{value:0}, uPulse:{value:0}, uLevel:{value:0}, uOpacity:{value:1},
    uGlow:{value:0.6}, uRadius:{value:3.0}, uSeed:{value:new THREE.Vector3()},
    uSpecTex:{value:specTex}, uColA:{value:new THREE.Color()}, uColB:{value:new THREE.Color()}
  };
  // both passes share the *same* uniform objects, so one update drives them
  const wireU = Object.assign({}, U, { uShrink:{value:1.0} });
  const coreU = Object.assign({}, U, { uShrink:{value:0.992} });

  const VERT = NOISE + `
    uniform float uAmp, uLow, uMid, uHigh, uBeat, uPulse, uShrink, uRadius;
    uniform vec3 uSeed;
    uniform sampler2D uSpecTex;
    attribute vec3 aBary;
    varying vec3 vBary; varying vec3 vN; varying vec3 vWorld; varying float vRidge;

    // radial displacement at direction n (unit vector on the sphere)
    float disp(vec3 n){
      // latitude -> FFT bin, mirrored about the equator so both hemispheres agree
      float u = (abs(n.y)*${BARS-1}.0 + 0.5)/${BARS}.0;
      float s = texture2D(uSpecTex, vec2(u, 0.5)).r;
      // three octaves, each weighted by its own band: lows swell the broad lobes,
      // mids fold the ridges, highs crinkle the surface
      float h  = snoise(n*1.15 + uSeed)                 * (0.55 + uLow *1.10);
      h += snoise(n*2.70 + uSeed*1.40 + 11.0) * 0.34 * (0.35 + uMid *1.30);
      h += snoise(n*6.20 + uSeed*0.70 + 27.0) * 0.13 * (0.30 + uHigh*1.40);
      h *= 0.55 + s*1.30;          // that latitude's energy scales its relief
      h += s*0.55;                 // ...and bulges the band outward on its own
      h += uBeat * 0.20 * sin(n.y*6.0 - uPulse);   // onset ripple running pole to pole
      return h * uAmp;
    }

    void main(){
      vBary = aBary;
      vec3 n = normalize(position);
      // tangent frame for finite-difference normals; the reference axis only
      // picks the basis, so swapping it near the poles leaves no seam
      vec3 ref = abs(n.y) < 0.985 ? vec3(0.0,1.0,0.0) : vec3(1.0,0.0,0.0);
      vec3 T = normalize(cross(ref, n));
      vec3 B = cross(n, T);
      const float e = 0.045;
      float h = disp(n);
      vec3 pC = n * (uRadius + h);
      vec3 nT = normalize(n + T*e); vec3 pT = nT * (uRadius + disp(nT));
      vec3 nB = normalize(n + B*e); vec3 pB = nB * (uRadius + disp(nB));
      vec3 cr = cross(pT - pC, pB - pC);
      float cl = length(cr);
      vec3 N = cl > 1e-9 ? cr/cl : n;           // never normalize a zero vector

      vRidge = h / max(uAmp, 0.001);            // normalized so colour keys off shape, not loudness
      vec4 wp = modelMatrix * vec4(pC * uShrink, 1.0);
      vWorld = wp.xyz;
      vN = normalize(mat3(modelMatrix) * N);    // rotation only, so no inverse-transpose needed
      gl_Position = projectionMatrix * viewMatrix * wp;
    }`;

  // Pass 1 — the shell. Near-black, but it writes depth, so the far side of the
  // mesh is occluded and the globe reads as a solid body rather than a cage.
  const coreMat = new THREE.ShaderMaterial({
    uniforms: coreU, transparent:true, side:THREE.FrontSide,
    vertexShader: VERT,
    fragmentShader: `
      uniform float uOpacity, uLevel, uBeat;
      uniform vec3 uColA, uColB;
      varying vec3 vBary; varying vec3 vN; varying vec3 vWorld; varying float vRidge;
      void main(){
        vec3 N = normalize(vN);
        vec3 V = normalize(cameraPosition - vWorld);
        vec3 L = normalize(vec3(0.45, 0.75, 0.55));
        float ndl = max(dot(N,L), 0.0);
        float fres = pow(max(1.0 - max(dot(N,V), 0.0), 0.0), 3.0);
        vec3 body = mix(uColA, uColB, clamp(vRidge*0.35 + 0.5, 0.0, 1.0));
        vec3 c = body * (0.030 + 0.075*ndl);                       // just enough to sit above black
        c += body * fres * (0.16 + uLevel*0.30 + uBeat*0.22);      // silhouette rim
        c = c/(1.0+c);
        gl_FragColor = vec4(c, uOpacity);
        #include <colorspace_fragment>
      }`
  });

  // Pass 2 — the glowing wireframe, additive over the shell.
  const wireMat = new THREE.ShaderMaterial({
    uniforms: wireU, transparent:true, depthWrite:false,
    blending:THREE.AdditiveBlending, side:THREE.FrontSide,
    vertexShader: VERT,
    fragmentShader: `
      uniform float uOpacity, uGlow;
      uniform vec3 uColA, uColB;
      varying vec3 vBary; varying vec3 vN; varying vec3 vWorld; varying float vRidge;
      void main(){
        // fwidth keeps the line a constant width in *pixels*, so the mesh stays
        // legible whether a triangle is facing us or skewed at the silhouette
        // fwidth() collapses to zero on a triangle that lands edge-on or
        // covers less than a pixel, and smoothstep with edge0 == edge1 is a
        // divide by zero. One NaN fragment survives into the bloom's mip chain
        // and comes back as a black block flickering over the frame, so the
        // width carries a floor it can never fall below.
        vec3 w = max(fwidth(vBary), vec3(1e-6));
        vec3 c1 = smoothstep(vec3(0.0), w*1.25, vBary);
        float core = 1.0 - min(min(c1.x,c1.y),c1.z);      // crisp filament
        vec3 c2 = smoothstep(vec3(0.0), w*6.00, vBary);
        float halo = 1.0 - min(min(c2.x,c2.y),c2.z);
        halo *= halo;                                     // bloom, falling off into the face

        vec3 V = normalize(cameraPosition - vWorld);
        // ...and dot() of two normalised vectors can come back a hair over 1,
        // which would hand pow() a negative base: undefined, and NaN in practice
        float rim = pow(max(1.0 - abs(dot(normalize(vN), V)), 0.0), 2.5);   // edges burn at the silhouette
        vec3 tint = mix(uColA, uColB, clamp(vRidge*0.35 + 0.5, 0.0, 1.0));

        float a = clamp(core + halo*0.38, 0.0, 1.0) * uOpacity;
        vec3 rgb = tint * uGlow * (0.75 + rim*1.15) * (1.0 + core*0.9);
        gl_FragColor = vec4(rgb, a);
        #include <colorspace_fragment>
      }`
  });
  // WebGL1 needs the derivatives extension for fwidth(); core in WebGL2
  coreMat.extensions = { derivatives:true }; wireMat.extensions = { derivatives:true };

  const grp = new THREE.Group();
  const core = new THREE.Mesh(geo, coreMat); core.renderOrder = 0;
  const wire = new THREE.Mesh(geo, wireMat); wire.renderOrder = 1;
  grp.add(core, wire); scene.add(grp);

  // every driver gets its own eased envelope on top of the audio engine's, so
  // the mesh breathes and never twitches — see NFR-8
  const sm = { level:0, low:0, mid:0, high:0, beat:0 };
  const specSm = new Float32Array(BARS);
  let t = 0, pulse = 0, spin = 0.1, amp = 0.10, glow = 0.6, hue = 0.55;

  presets.push({
    name:'Sphere', desc:'wire-mesh globe · spectral relief', scene, camera,
    resize(){ camera.aspect=W/H; camera.updateProjectionMatrix(); },
    update(dt,A){
      sm.level += (A.level - sm.level) * ease(dt, 5);
      sm.low   += (A.low   - sm.low  ) * ease(dt, 4);
      sm.mid   += (A.mid   - sm.mid  ) * ease(dt, 5);
      sm.high  += (A.high  - sm.high ) * ease(dt, 6);
      sm.beat  += (A.beat  - sm.beat ) * ease(dt, 9);

      const sk = ease(dt, 7);
      for(let i=0;i<BARS;i++){
        specSm[i] += (A.spectrum[i] - specSm[i]) * sk;
        const v = Math.max(0, Math.min(255, specSm[i]*255))|0;
        specData[i*4]=v; specData[i*4+1]=v; specData[i*4+2]=v; specData[i*4+3]=255;
      }
      specTex.needsUpdate = true;

      t += dt * MOTION * (0.30 + sm.level*0.55 + sm.beat*0.25);
      pulse = (pulse + dt * MOTION * 5.0) % 6.2831853;   // wrapped: stays precise over long runs
      // the noise domain drifts on a slow lissajous, so the relief flows over the
      // body instead of sliding across it in one direction
      U.uSeed.value.set(Math.sin(t*0.31)*1.6, Math.cos(t*0.27)*1.6, Math.sin(t*0.19)*1.3);

      // amplitude, glow and spin are slew-limited: a loud transient swells the
      // mesh over a few frames rather than snapping it
      amp  += ((0.10 + sm.level*0.42 + sm.low*0.18)*MOTION - amp ) * ease(dt, 2.5);
      glow += ((0.55 + sm.level*0.55 + sm.beat*0.45*MOTION) - glow) * ease(dt, 5);
      spin += ((0.10 + sm.level*0.42 + sm.beat*0.20) - spin) * ease(dt, 2);
      hue  += ((0.55 - sm.high*0.10 + sm.low*0.04) - hue) * ease(dt, 1.5);

      const hu = (hue + A.time*0.010) % 1;
      U.uColA.value.copy(col.setHSL((hu + 0.06) % 1, 0.85, 0.30));   // valleys, deep
      U.uColB.value.copy(col.setHSL((hu + 0.88) % 1, 0.90, 0.68));   // ridges, hot
      U.uAmp.value = amp;   U.uGlow.value = glow;  U.uPulse.value = pulse;
      U.uLow.value = sm.low; U.uMid.value = sm.mid; U.uHigh.value = sm.high;
      U.uLevel.value = sm.level; U.uBeat.value = sm.beat;
      U.uOpacity.value = A.opacity;

      grp.rotation.y += dt * spin * MOTION;
      grp.rotation.x = Math.sin(t*0.23) * 0.20;
      grp.rotation.z = Math.cos(t*0.17) * 0.10;
    }
  });
}
/* --- 8. GLITCH : a corrupted video panel — data rows, torn slices, RGB split --- */
function makeGlitch(){
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, W/H, 0.1, 100); camera.position.set(0,0,12);

  // live spectrum as a 1-D texture, as in Sphere: here the panel's rows sample
  // it, so every row of the readout is driven by its own slice of the FFT
  const specData = new Uint8Array(BARS*4);
  const specTex = new THREE.DataTexture(specData, BARS, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
  specTex.minFilter = specTex.magFilter = THREE.LinearFilter;
  specTex.wrapS = specTex.wrapT = THREE.ClampToEdgeWrapping;
  specTex.generateMipmaps = false; specTex.needsUpdate = true;

  const U = {
    uSpec:{value:specTex}, uStepI:{value:0}, uStepF:{value:0},
    uTear:{value:0}, uSlip:{value:0}, uMosh:{value:0}, uSplit:{value:0}, uRoll:{value:0},
    uStatic:{value:0.05}, uGain:{value:1}, uOpacity:{value:1}, uPx:{value:dpr},
    uColA:{value:new THREE.Color()}, uColB:{value:new THREE.Color()}
  };

  // One quad, all the work in the fragment shader. It is built far larger than
  // the frame so zooming out and dragging reveal more signal rather than its
  // edges; a wide radial falloff dissolves it into the background out there.
  const geo = new THREE.PlaneGeometry(160, 90);
  const mat = new THREE.ShaderMaterial({
    uniforms: U, transparent:true, depthWrite:false,
    vertexShader: `
      varying vec2 vXY;
      void main(){ vXY = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `
      uniform sampler2D uSpec;
      uniform float uStepI, uStepF, uTear, uSlip, uMosh, uSplit, uRoll, uStatic, uGain, uOpacity, uPx;
      uniform vec3 uColA, uColB;
      varying vec2 vXY;

      const float ROW  = 0.46;          // data row height, in panel units
      const float NROW = 26.0;          // rows per full sweep of the spectrum
      const float CYC  = ROW*NROW;      // ...so one sweep is about one screenful
      const float CELL = 0.62;          // cell width

      float hash21(vec2 p){
        vec3 p3 = fract(vec3(p.xyx) * 0.1031);
        p3 += dot(p3, p3.yzx + 33.33);
        return fract((p3.x + p3.y) * p3.z);
      }
      // The readout redraws in discrete frames like a video signal, so every
      // random it uses is drawn at one step and cross-faded into the next.
      // Anything driving *brightness* goes through here: the cells churn, but
      // nothing ever hard-cuts, which is what would turn churn into flicker.
      float hashT(vec2 p){
        return mix(hash21(p + vec2(uStepI*17.13, uStepI*7.71)),
                   hash21(p + vec2(uStepI*17.13 + 17.13, uStepI*7.71 + 7.71)), uStepF);
      }
      float spec(float f){
        return texture2D(uSpec, vec2(f*${(BARS-1)/BARS} + ${0.5/BARS}, 0.5)).r;
      }

      // The signal itself: rows of cells, each row one FFT band, each cell lit
      // by its own churning random weighted by that band's energy.
      float panel(vec2 p){
        float row = floor(p.y/ROW);
        float e   = spec(fract(row/NROW));       // row -> bin, repeating up the panel
        float h   = hashT(vec2(floor(p.x/CELL), row)*vec2(1.0, 1.7));
        float v   = smoothstep(0.62, 0.96, h*0.50 + e*1.05);
        v *= 0.55 + h*0.75;                      // ...and each lit cell keeps its own brightness
        v = max(v, 0.04 + e*0.13);               // dim floor: the grid is always faintly there
        // gutters between rows and cells, widened by a pixel so they stop
        // aliasing into moire once the panel is zoomed out
        vec2 fp = fract(p/vec2(CELL, ROW));
        vec2 aa = fwidth(p/vec2(CELL, ROW))*1.5;
        float gy = smoothstep(0.0, 0.10+aa.y, fp.y) * smoothstep(1.0, 0.90-aa.y, fp.y);
        float gx = smoothstep(0.0, 0.06+aa.x, fp.x) * smoothstep(1.0, 0.94-aa.x, fp.x);
        return v * gx * gy;
      }

      // Sync roll: a soft band travelling up the panel, dragging what it crosses.
      float sync(vec2 p){ return smoothstep(0.045, 0.0, abs(fract((p.y - uRoll)/CYC) - 0.5)); }

      // Tearing: the panel is cut into slices and a random few slide sideways.
      // Purely positional — the slices move, nothing changes brightness — which
      // is what keeps a glitch preset inside the motion-safety floor (NFR-8).
      vec2 tear(vec2 p, float bar){
        float sl = floor(p.y/(ROW*2.0));
        vec2  k  = vec2(sl, floor(uStepI));
        float pick = step(1.0 - uTear, hash21(k*3.17));
        p.x += (hash21(k*7.91)*2.0 - 1.0) * pick * uSlip;
        p.x += bar * uSlip * 0.30;
        // ...and on an onset a few whole tiles resample from elsewhere on the
        // panel, so they come back carrying the wrong part of the signal
        vec2 b = floor(p/vec2(CELL*3.0, ROW*2.0));
        vec2 kb = vec2(dot(b, vec2(1.0, 37.0)), floor(uStepI));
        float hit = step(1.0 - uMosh, hash21(kb*1.31));
        p += hit * (vec2(hash21(kb*5.70), hash21(kb*9.30))*2.0 - 1.0) * vec2(CELL*7.0, ROW*5.0);
        return p;
      }

      void main(){
        float bar = sync(vXY);
        vec2 p = tear(vXY, bar);
        // one sample per channel, offset sideways: the panel comes back white
        // where it lines up and fringed cyan/red wherever the signal has an edge
        vec3 sig = vec3(panel(p + vec2(uSplit,0.0)), panel(p), panel(p - vec2(uSplit,0.0)));
        sig += bar*0.10;

        float lum = dot(sig, vec3(0.3333));
        vec3 c = sig * mix(uColA, uColB, smoothstep(0.22, 0.92, lum)) * uGain;

        // scanlines and static belong to the display, not the scene, so both are
        // measured in screen pixels and hold still through zoom and drag
        float sy = gl_FragCoord.y/uPx;
        c *= 0.90 + 0.10*cos(sy*2.0944);                        // ~3 px pitch
        c += uColA * (hashT(gl_FragCoord.xy*0.37) - 0.5) * uStatic;

        float vig = smoothstep(52.0, 22.0, length(vXY));
        gl_FragColor = vec4(max(c, 0.0), uOpacity * vig);
        #include <colorspace_fragment>
      }`
  });
  mat.extensions = { derivatives:true };        // fwidth(): core in WebGL2, an extension in 1
  const mesh = new THREE.Mesh(geo, mat); scene.add(mesh);

  // eased envelopes on top of the audio engine's, as everywhere else
  const sm = { level:0, high:0, beat:0 };
  const specSm = new Float32Array(BARS);
  let t = 0, step = 0, roll = 0, tear = 0.04, slip = 0.6, mosh = 0, split = 0.02, hue = 0.55;

  presets.push({
    name:'Glitch', desc:'corrupted signal · tears + RGB split', scene, camera,
    resize(){ camera.aspect=W/H; camera.updateProjectionMatrix(); },
    update(dt,A){
      sm.level += (A.level - sm.level) * ease(dt, 5);
      sm.high  += (A.high  - sm.high ) * ease(dt, 6);
      sm.beat  += (A.beat  - sm.beat ) * ease(dt, 9);

      const sk = ease(dt, 7);
      for(let i=0;i<BARS;i++){
        specSm[i] += (A.spectrum[i] - specSm[i]) * sk;
        const v = Math.max(0, Math.min(255, specSm[i]*255))|0;
        specData[i*4]=v; specData[i*4+1]=v; specData[i*4+2]=v; specData[i*4+3]=255;
      }
      specTex.needsUpdate = true;

      t += dt;
      // ~6-12 frames a second, so the readout churns at video rate instead of
      // at whatever the display happens to run at
      step += dt * (6 + sm.level*6) * MOTION;
      U.uStepI.value = Math.floor(step);
      U.uStepF.value = step - Math.floor(step);
      roll = (roll + dt*MOTION*(0.9 + sm.level*1.8)) % (0.46*26);

      // how much tears, how far they slide, and how wide the channels separate:
      // all slew-limited, so an onset rips the picture over a few frames
      tear  += ((0.04 + sm.beat*0.40 + sm.level*0.10)*MOTION - tear ) * ease(dt, 6);
      slip  += ((0.60 + sm.level*2.20 + sm.beat*3.20)*MOTION - slip ) * ease(dt, 4);
      mosh  += ((sm.beat*0.13 + sm.level*0.02)*MOTION - mosh ) * ease(dt, 5);
      split += ((0.010 + sm.level*0.045 + sm.beat*0.085)*MOTION - split) * ease(dt, 5);
      hue   += ((0.55 - sm.high*0.12) - hue) * ease(dt, 1.5);

      U.uTear.value = tear; U.uSlip.value = slip; U.uMosh.value = mosh;
      U.uSplit.value = split; U.uRoll.value = roll;
      U.uStatic.value = 0.09 + sm.high*0.18 + sm.beat*0.04;
      // onsets are spent on tearing, not on brightness: this panel fills the
      // whole frame, so a beat term big enough to see here would be a full-field
      // luminance swing — the one thing NFR-8 rules out
      U.uGain.value = 0.90 + sm.level*0.45 + sm.beat*0.20;
      U.uOpacity.value = A.opacity;

      const hu = (hue + A.time*0.010) % 1;
      U.uColA.value.copy(col.setHSL(hu, 0.90, 0.26));            // dim cells, cold
      U.uColB.value.copy(col.setHSL((hu + 0.52) % 1, 0.62, 0.88)); // hot cells, near-white

      // a slow parallax slide across the panel, plus a push-in on loud passages
      camera.position.x = Math.sin(t*0.13)*0.35*MOTION;
      camera.position.y = Math.cos(t*0.11)*0.22*MOTION;
      camera.position.z = 12 - sm.level*0.8 - sm.beat*0.5;
    }
  });
}

makeTunnel(); makeRadial(); makeTerrain(); makeWaveform(); makeStarfield(); makeSilk(); makeSphere(); makeGlitch();

/* =========================================================================
   TEXT OVERLAY  —  a caption drawn dead centre, over the finished frame.
   It lives in a screen-space scene of its own rather than inside a preset, for
   one reason: the global Glow must not touch it. The overlay is composited
   after the bloom pass and carries its own, independent glow — drawn into the
   glyphs rather than post-processed — while Color, which comes after, still
   grades it along with everything else.
   ========================================================================= */
const TEXT_SS = 2;                     // supersample factor for crisp glyphs
const TEXT_SWELL = 0.35;               // extra size at full level, on top of the slider
// Text Glow is painted, not post-processed: the caption is drawn again into a
// companion canvas through canvas-2D shadows, and that halo is laid under the
// glyphs additively. Radius and opacity both ramp with the slider, so low
// settings read as a tight rim and high settings as a wide corona. Keeping the
// halo on its own quad means its intensity can pulse every frame without
// anything being redrawn.
const textGlowBlur  = t => 0.08 + 0.42*t;   // widest shadow radius, as a fraction of the font size
const textGlowAlpha = t => 0.45 + 0.75*t;   // opacity of the halo quad
// Light does not fall off at one rate. A single blur — or the same blur stacked
// to deepen it — gives a flat, evenly lit collar that reads as a sticker behind
// the text. Four shadows at shrinking radii, accumulated as light rather than
// paint, give a hot rim tight against the glyph decaying into a wide corona:
// the same layered-additive trick the Waveform preset uses on its trace, and
// the reason it looks like a lit object rather than a blurred copy.
const TEXT_GLOW_LAYERS = [
  { r: 1.00, a: 0.55 },                     // wide corona
  { r: 0.46, a: 0.62 },
  { r: 0.19, a: 0.78 },
  { r: 0.07, a: 0.95 }                      // hot rim, right at the glyph edge
];
const hexRGB = h => /^#[0-9a-f]{6}$/i.test(h) ? [1,3,5].map(i => parseInt(h.slice(i, i+2), 16)) : [255,255,255];
// System font stacks — nothing is downloaded, so the caption draws on the first
// frame. Display carries a weight as well as a family: the heavy faces it asks
// for are missing on plenty of machines, and without the 900 it would fall back
// to something indistinguishable from Sans.
const FONTS = {
  sans:      { weight:400, stack:'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif' },
  serif:     { weight:400, stack:'Georgia, "Times New Roman", Times, serif' },
  mono:      { weight:400, stack:'ui-monospace, "SF Mono", Menlo, Consolas, "Courier New", monospace' },
  display:   { weight:900, stack:'"Arial Black", Impact, Haettenschweiler, system-ui, sans-serif' },
  condensed: { weight:400, stack:'"Arial Narrow", "Helvetica Neue Condensed", "Liberation Sans Narrow", system-ui, sans-serif' }
};
const textCanvas = document.createElement('canvas'), tctx = textCanvas.getContext('2d');
const glowCanvas = document.createElement('canvas'), gctx = glowCanvas.getContext('2d');
function makeTextTex(cv){
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;        // the 2D canvas hands back sRGB
  t.generateMipmaps = false;                  // drawn ~1:1 on screen
  t.minFilter = THREE.LinearFilter;
  return t;
}
const textTex = makeTextTex(textCanvas), glowTex = makeTextTex(glowCanvas);
const textMat = new THREE.MeshBasicMaterial({
  map: textTex, transparent: true, depthTest: false, depthWrite: false, fog: false
});
// Additive, so the halo lifts whatever is behind it instead of veiling it —
// the same trick the Waveform preset uses for its glow, and the reason this
// caption needs no bloom of its own.
const glowMat = new THREE.MeshBasicMaterial({
  map: glowTex, transparent: true, depthTest: false, depthWrite: false, fog: false,
  blending: THREE.AdditiveBlending, opacity: 0
});
const textGeo = new THREE.PlaneGeometry(1, 1);
let textW = 0, textH = 0;                     // rendered size in CSS pixels
let textSwell = 1;                            // eased level-driven size multiplier

// The overlay scene: an orthographic camera spanning the viewport in CSS
// pixels, so the size control is simply the quad's height in world units and
// nothing has to be re-derived from the active preset's field of view or zoom.
const textScene = new THREE.Scene();
const textCam = new THREE.OrthographicCamera(-W/2, W/2, H/2, -H/2, -1, 1);
function sizeTextCam(){
  textCam.left = -W/2; textCam.right = W/2; textCam.top = H/2; textCam.bottom = -H/2;
  textCam.updateProjectionMatrix();
}
const glowQuad = new THREE.Mesh(textGeo, glowMat);
const textQuad = new THREE.Mesh(textGeo, textMat);
glowQuad.renderOrder = 0; textQuad.renderOrder = 1;   // halo first, glyphs over it
glowQuad.visible = textQuad.visible = false;
textScene.add(glowQuad, textQuad);

// Composited straight into whatever the chain holds so far, so the caption is
// laid over the bloomed frame rather than fed into the bloom. `needsSwap` is
// false because nothing is copied: the overlay draws into the read buffer and
// the next pass reads it back.
class OverlayPass extends Pass {
  constructor(scene, camera){ super(); this.scene = scene; this.camera = camera; this.needsSwap = false; }
  render(renderer, writeBuffer, readBuffer){
    const auto = renderer.autoClear;
    renderer.autoClear = false;               // draw on top; never wipe the frame
    renderer.setRenderTarget(this.renderToScreen ? null : readBuffer);
    renderer.render(this.scene, this.camera);
    renderer.autoClear = auto;
  }
}
const overlayPass = new OverlayPass(textScene, textCam);
overlayPass.enabled = false;                  // nothing to draw until there is a caption
composer.insertPass(overlayPass, composer.passes.indexOf(gradePass));

// Every preset gets a content root holding what it draws, so the view transform
// (drag + Movement) can turn the scene without turning the camera.
presets.forEach(p => {
  p.scene.background = new THREE.Color(BG);
  const root = new THREE.Group();
  while (p.scene.children.length) root.add(p.scene.children[0]);
  p.scene.add(root);
  p.root = root;
});

// Redraw the caption into its canvases. Canvas 2D resets its state whenever the
// element is resized, so the font is measured, the canvas sized, then set again.
function drawText(){
  const lines = state.text.split('\n');
  const has = state.text.trim().length > 0;
  const glowOn = has && state.textGlow > 0;
  textQuad.visible = has;
  glowQuad.visible = glowOn;
  overlayPass.enabled = has;
  if(!has) return;
  const px = state.textSize * TEXT_SS;
  const f = FONTS[state.textFont] || FONTS.sans;
  const font = `${f.weight} ${px}px ${f.stack}`;
  tctx.font = font;
  let w = 0;
  for(const line of lines) w = Math.max(w, tctx.measureText(line).width);
  // The halo needs room or it is cut off at the canvas edge: a canvas shadow of
  // radius b has faded to nothing by roughly 1.3b, so that is the extra margin.
  const blur = glowOn ? px*textGlowBlur(state.textGlow) : 0;
  const lh = px*1.28, padX = px*0.35 + blur*1.3, padY = px*0.30 + blur*1.3;
  const cw = Math.max(Math.min(Math.ceil(w + padX*2), 4096), 2);
  const ch = Math.max(Math.min(Math.ceil(lines.length*lh + padY*2), 4096), 2);
  if(textCanvas.width !== cw || textCanvas.height !== ch){
    // A canvas texture's GPU storage is immutable and sized by its first upload,
    // so once the caption grows — every keystroke does — the new canvas would be
    // pushed into the old, smaller allocation and come back as garbage. Dropping
    // the texture makes three allocate again at the size actually being drawn.
    textTex.dispose(); glowTex.dispose();
    textCanvas.width = cw; textCanvas.height = ch;
    glowCanvas.width = cw; glowCanvas.height = ch;
  }
  // Both canvases are the same size and take the same strokes, so the halo sits
  // exactly under the glyphs however the two quads are scaled.
  const paint = (ctx, dx = 0) => {
    ctx.font = font;                          // canvas state is reset by a resize
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = state.textColour;
    for(let i=0;i<lines.length;i++) ctx.fillText(lines[i], cw/2 + dx, padY + lh*(i + 0.5));
  };
  tctx.clearRect(0, 0, cw, ch);                // resizing clears; same size does not
  paint(tctx);
  textTex.needsUpdate = true;
  gctx.clearRect(0, 0, cw, ch);
  if(glowOn){
    const [r, g, b] = hexRGB(state.textColour);   // the halo takes the caption's own colour
    // Only the shadow is wanted, never a second copy of the glyphs: the text is
    // drawn well off the left edge and its shadow offset back onto the canvas.
    // Letting the glyphs land here too would stack four opaque copies under the
    // crisp layer and burn the core out to white at any real setting.
    const off = cw + blur*2 + 16;
    gctx.globalCompositeOperation = 'lighter';    // layers accumulate as light, not as paint
    gctx.shadowOffsetX = off;
    for(const L of TEXT_GLOW_LAYERS){
      gctx.shadowColor = `rgba(${r}, ${g}, ${b}, ${L.a})`;
      gctx.shadowBlur = Math.max(blur*L.r, 0.5);  // a sub-pixel radius draws nothing at all
      paint(gctx, -off);
    }
    gctx.shadowOffsetX = 0; gctx.shadowBlur = 0; gctx.shadowColor = 'transparent';
    gctx.globalCompositeOperation = 'source-over';
  }
  glowTex.needsUpdate = true;
  textW = cw/TEXT_SS; textH = ch/TEXT_SS;
}
// A redraw is the expensive part of any text control — the glow especially —
// and a slider drag or a held key fires several input events per frame, so they
// are coalesced into one redraw at the top of the next frame.
let textDirty = false;
const queueText = () => { textDirty = true; };

// Size the quads so the caption covers exactly the pixels the slider asks for —
// then swell it with the level. The slider size is the resting size, at
// silence; louder pushes it up to +35%. `A.level` is already attack/release
// smoothed, and this eases on top of it, so the caption breathes with the
// signal instead of chattering on every frame. Damped, like every other pulse,
// under reduce-motion.
function fitText(dt, A){
  textSwell += ((1 + A.level*TEXT_SWELL*MOTION) - textSwell) * ease(dt, 7);
  if(!textQuad.visible) return;
  const w = textW*textSwell, h = textH*textSwell;
  textQuad.scale.set(w, h, 1);
  glowQuad.scale.set(w, h, 1);
  // the halo swells on onsets, as the global glow does — its own reactivity,
  // driven by the text slider alone
  if(glowQuad.visible) glowMat.opacity = textGlowAlpha(state.textGlow) * (1 + A.beat*0.25*MOTION);
}

/* =========================================================================
   PRESET SWITCHING + RENDER LOOP
   ========================================================================= */
let active = 0;
function selectPreset(i){
  active = (i+presets.length)%presets.length;
  presets[active].resize();
  [...presetList.children].forEach((li,k)=>li.classList.toggle('active', k===active));
}
const clock = new THREE.Clock();
function loop(){
  requestAnimationFrame(loop);
  const dt = Math.min(clock.getDelta(), 0.05);
  analyse(dt);
  const p = presets[active];
  p.update(dt, Audio);
  p.camera.zoom = state.zoom; p.camera.updateProjectionMatrix();   // composes with per-preset camera motion
  updateWander(dt, Audio);
  applyView(p);
  if(textDirty){ textDirty = false; drawText(); }
  fitText(dt, Audio);
  if(fxActive){
    // glow swells a little on onsets, like every other parameter here
    if(bloomPass.enabled) bloomPass.strength = glowStrength(state.glow) * (1 + Audio.beat*0.25*MOTION);
    // the flare swells with it, but no harder: a lens artifact pumping on every
    // beat is exactly the full-frame flicker the motion-safety floor rules out
    if(flarePass.enabled) flareComposite.uniforms.uAmount.value = flareStrength(state.flare) * (1 + Audio.beat*0.25*MOTION);
    renderPass.scene = p.scene; renderPass.camera = p.camera;
    composer.render();
  } else {
    renderer.render(p.scene, p.camera);
    // with the post chain bypassed the overlay pass never runs, so the caption
    // is laid over the finished frame here instead — the same composite
    if(textQuad.visible){
      renderer.autoClear = false;
      renderer.render(textScene, textCam);
      renderer.autoClear = true;
    }
  }
  updateMeters();
}
// NOTE: loop() is started at the very end, after all DOM refs + UI wiring exist.

/* =========================================================================
   UI WIRING
   ========================================================================= */
const app = document.getElementById('app');
const presetList = document.getElementById('presetList');
document.getElementById('presetHint').textContent = `1\u2013${presets.length}`;
presets.forEach((p,i)=>{
  const li=document.createElement('li');
  li.className='preset'+(i===0?' active':''); li.tabIndex=0;
  li.innerHTML=`<span class="idx">${i+1}</span><span class="meta"><span class="name">${p.name}</span><span class="desc">${p.desc}</span></span>`;
  li.onclick=()=>selectPreset(i);
  li.onkeydown=e=>{ if(e.key==='Enter'||e.key===' '){e.preventDefault();selectPreset(i);} };
  presetList.appendChild(li);
});

// panel + fullscreen
const handle=document.getElementById('handle');
handle.onclick=()=>app.classList.toggle('collapsed');
document.getElementById('fsBtn').onclick=toggleFs;
function toggleFs(){ if(!document.fullscreenElement) document.documentElement.requestFullscreen?.(); else document.exitFullscreen?.(); }

// mic control + status
const micBtn=document.getElementById('micBtn');
const micStatusEl=document.getElementById('micStatus');
const micHintEl=document.getElementById('micHint');
let resumeArmed=false;

function armResume(){
  if(resumeArmed) return; resumeArmed=true;
  const h=()=>{
    if(Audio.ctx) Audio.ctx.resume().then(setMicStatus);
    window.removeEventListener('pointerdown',h); window.removeEventListener('keydown',h);
    resumeArmed=false;
  };
  window.addEventListener('pointerdown',h); window.addEventListener('keydown',h);
}

function setMicStatus(state){
  // derive state if not explicitly passed
  if(!state){
    if(Audio.micStream){ state = (Audio.ctx && Audio.ctx.state==='running') ? 'live' : 'suspended'; }
    else state = 'stopped';
  }
  const live = state==='live';
  micBtn.classList.toggle('live', live);
  const map = {
    requesting:['◌ Requesting access…', 'REQ', 'Waiting for microphone permission…'],
    live:      ['● Listening — click to stop', 'LIVE', 'Listening to your microphone. Output is muted to avoid feedback — use headphones if audio is playing nearby.'],
    suspended: ['▶ Click anywhere to start', 'HOLD', 'Your browser paused audio until you interact — click anywhere or press a key to start.'],
    stopped:   ['● Start microphone', 'OFF', 'Microphone is off. Click to start listening.'],
    blocked:   ['⟳ Blocked — click to retry', 'DENIED', 'Microphone permission was denied. Allow it in your browser’s site settings, then click to retry.'],
    error:     ['⟳ No microphone — retry', 'ERR', 'No microphone was found or it could not be opened. Check your device, then click to retry.']
  };
  const [label, tag, hint] = map[state] || map.stopped;
  micBtn.textContent = label;
  micStatusEl.textContent = tag;
  micStatusEl.style.color = live ? 'var(--hot)' : 'var(--muted-2)';
  micHintEl.textContent = hint;
}

micBtn.onclick=()=>{
  if(micBtn.classList.contains('live')) stopMic();
  else startMic();
};

// sensitivity
const sensVal=document.getElementById('sensVal');
document.getElementById('sens').oninput=e=>{
  Audio.sensitivity=e.target.value/100;
  sensVal.textContent=e.target.value+'%';
};

// effects — glow (bloom), flare (lens artifact), movement (random drift) and
// colour (saturation + brightness)
const glowVal=document.getElementById('glowVal'), flareVal=document.getElementById('flareVal'),
      moveVal=document.getElementById('moveVal'), colourVal=document.getElementById('colourVal');
function setGlow(v){
  state.glow = v/100;
  bloomPass.threshold = glowThreshold(state.glow);
  bloomPass.radius    = glowRadius(state.glow);
  glowVal.textContent = v>0 ? v+'%' : 'Off';
  refreshFx();
}
function setFlare(v){
  state.flare = v/100;
  flarePass.bright.uniforms.uThreshold.value = flareThreshold(state.flare);
  flarePass.features.uniforms.uDistortion.value = flareDistortion(state.flare);
  flareVal.textContent = v>0 ? v+'%' : 'Off';
  refreshFx();
}
function setColour(v){
  state.colour = v/100;                        // 0 - 2, 1 = the preset's own look
  gradePass.uniforms.uSat.value = state.colour;
  gradePass.uniforms.uBright.value = 0.40 + 0.60*state.colour;
  colourVal.textContent = v+'%';
  refreshFx();
}
function setMovement(v){
  state.movement = v/100;
  moveVal.textContent = v>0 ? v+'%' : 'Off';
}
document.getElementById('glow').oninput=e=>setGlow(+e.target.value);
document.getElementById('flare').oninput=e=>setFlare(+e.target.value);
document.getElementById('move').oninput=e=>setMovement(+e.target.value);
document.getElementById('colour').oninput=e=>setColour(+e.target.value);

// text overlay — content, screen size, font, fill colour and its own glow
const textInput=document.getElementById('textInput'), textHint=document.getElementById('textHint'),
      textSizeVal=document.getElementById('textSizeVal'),
      textColourVal=document.getElementById('textColourVal'), textGlowVal=document.getElementById('textGlowVal');
function refreshTextHint(){
  const n = state.text.trim() ? state.text.split('\n').length : 0;
  textHint.textContent = n ? (n===1 ? '1 line' : n+' lines') : 'Off';
}
textInput.oninput=e=>{ state.text = e.target.value; queueText(); refreshTextHint(); };
document.getElementById('textSize').oninput=e=>{
  state.textSize = +e.target.value;
  textSizeVal.textContent = state.textSize + 'px';
  queueText();
};
document.getElementById('textFont').onchange=e=>{ state.textFont = e.target.value; queueText(); };
document.getElementById('textColour').oninput=e=>{
  state.textColour = e.target.value;            // colours the glyphs and their halo
  textColourVal.textContent = state.textColour.toUpperCase();
  queueText();
};
// deliberately not wired to the Effects group: this glow is the caption's alone
document.getElementById('textGlow').oninput=e=>{
  const v = +e.target.value;
  state.textGlow = v/100;
  textGlowVal.textContent = v>0 ? v+'%' : 'Off';
  queueText();
};


// zoom / view controls
const zoomVal=document.getElementById('zoomVal');
function setZoom(z){ state.zoom=THREE.MathUtils.clamp(z,0.3,6); zoomVal.textContent=Math.round(state.zoom*100)+'%'; }
function zoomBy(f){ setZoom(state.zoom*f); }
document.getElementById('zoomIn').onclick=()=>zoomBy(1.15);
document.getElementById('zoomOut').onclick=()=>zoomBy(1/1.15);
document.getElementById('zoomReset').onclick=()=>{ setZoom(1); resetView(); };
canvas.addEventListener('wheel',e=>{ e.preventDefault(); zoomBy(Math.exp(-e.deltaY*0.0015)); },{passive:false});

// drag the viewport to look around. Pitch is clamped short of straight up/down
// so the scene can never end up upside down with no way back.
const ORBIT_SPEED = 0.005, ORBIT_PITCH = 1.2;
let drag = null;
function resetView(){ state.orbit.x = state.orbit.y = 0; }
canvas.addEventListener('pointerdown',e=>{
  if(e.button !== 0) return;
  drag = { x:e.clientX, y:e.clientY };
  canvas.setPointerCapture(e.pointerId);
  canvas.classList.add('dragging');
});
canvas.addEventListener('pointermove',e=>{
  if(!drag) return;
  state.orbit.y += (e.clientX - drag.x) * ORBIT_SPEED;
  state.orbit.x = THREE.MathUtils.clamp(state.orbit.x + (e.clientY - drag.y) * ORBIT_SPEED, -ORBIT_PITCH, ORBIT_PITCH);
  drag.x = e.clientX; drag.y = e.clientY;
});
for(const ev of ['pointerup','pointercancel']) canvas.addEventListener(ev,e=>{
  if(!drag) return;
  drag = null;
  try { canvas.releasePointerCapture(e.pointerId); } catch(err){}
  canvas.classList.remove('dragging');
});
canvas.addEventListener('dblclick',resetView);

// meters
const vuFill=document.getElementById('vuFill'), vuPeak=document.getElementById('vuPeak'), dbVal=document.getElementById('dbVal');
const bLow=document.getElementById('bLow'), bMid=document.getElementById('bMid'), bHigh=document.getElementById('bHigh');
const beatDot=document.getElementById('beatDot'), bpmEl=document.getElementById('bpm');
function updateMeters(){
  vuFill.style.width=(Audio.level*100).toFixed(1)+'%';
  vuPeak.style.left=(Audio.peakLevel*100).toFixed(1)+'%';
  dbVal.textContent = Audio.levelDb<=-99 ? '−∞ dB' : Audio.levelDb.toFixed(1)+' dB';
  bLow.style.height=(Audio.low*100).toFixed(0)+'%';
  bMid.style.height=(Audio.mid*100).toFixed(0)+'%';
  bHigh.style.height=(Audio.high*100).toFixed(0)+'%';
  const b=Audio.beat;
  beatDot.style.borderColor = b>0.25 ? 'var(--hot)' : 'var(--line-strong)';
  beatDot.style.boxShadow = b>0.25 ? '0 0 16px rgba(255,77,61,'+b.toFixed(2)+')' : 'none';
  beatDot.style.background = 'radial-gradient(circle, rgba(255,77,61,'+(b*0.85).toFixed(2)+') 28%, transparent 60%)';
  bpmEl.textContent = Audio.bpm ? Audio.bpm+' bpm' : '— bpm';
}

// keyboard
addEventListener('keydown',e=>{
  if(/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
  if(e.key==='h'||e.key==='H') app.classList.toggle('collapsed');
  else if(e.key==='f'||e.key==='F') toggleFs();
  else if(e.key>='1'&&e.key<='9'&&+e.key<=presets.length) selectPreset(+e.key-1);
  else if(e.key==='ArrowRight') selectPreset(active+1);
  else if(e.key==='ArrowLeft') selectPreset(active-1);
  else if(e.key==='+'||e.key==='=') zoomBy(1.15);
  else if(e.key==='-'||e.key==='_') zoomBy(1/1.15);
  else if(e.key==='0'){ setZoom(1); resetView(); }
});

// resize
addEventListener('resize',()=>{ sizeRenderer(); sizeComposer(); sizeTextCam(); presets.forEach(p=>p.resize()); });

// request microphone and start listening on first load
startMic();

// start the render loop now that every DOM reference and preset is initialized
loop();
