import * as THREE from 'three';

/* =========================================================================
   RENDERER
   ========================================================================= */
const canvas = document.getElementById('gl');
const renderer = new THREE.WebGLRenderer({ canvas, antialias:true, powerPreference:'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setClearColor(0x0b0c10, 1);
let W = innerWidth, H = innerHeight;
function sizeRenderer(){ W = innerWidth; H = innerHeight; renderer.setSize(W, H); }
sizeRenderer();

// global view state shared by all presets
const state = { zoom: 1 };

// respect the OS "reduce motion" accessibility setting → damp motion + pulses
const REDUCED_MOTION = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const MOTION = REDUCED_MOTION ? 0.5 : 1;

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
  // widest/faintest first so the bright core lands on top. `edge` is how much
  // colour survives at the outer edge: 0 = soft halo, 1 = solid line.
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
      let dx = -ty/len*mi, dy = (tx/len)*mi + (1-mi);
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
      const amp  = halfH*(0.05 + sDrive*0.80 + A.beat*0.05*MOTION);

      // 1-2-1 pass over the samples: rounds the polyline without dulling the shape
      for(let i=0;i<P;i++) sm[i] = THREE.MathUtils.clamp(A.wave[i]*norm, -1.4, 1.4);
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
        float fres = pow(1.0 - max(dot(N,V), 0.0), 6.0);

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
makeTunnel(); makeRadial(); makeTerrain(); makeWaveform(); makeStarfield(); makeSilk();

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
  presets[active].update(dt, Audio);
  const cam = presets[active].camera;
  cam.zoom = state.zoom; cam.updateProjectionMatrix();   // composes with per-preset camera motion
  renderer.render(presets[active].scene, presets[active].camera);
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
document.getElementById('sens').oninput=e=>{ Audio.sensitivity=e.target.value/100; };

// zoom / view controls
const zoomVal=document.getElementById('zoomVal');
function setZoom(z){ state.zoom=THREE.MathUtils.clamp(z,0.3,6); zoomVal.textContent=Math.round(state.zoom*100)+'%'; }
function zoomBy(f){ setZoom(state.zoom*f); }
document.getElementById('zoomIn').onclick=()=>zoomBy(1.15);
document.getElementById('zoomOut').onclick=()=>zoomBy(1/1.15);
document.getElementById('zoomReset').onclick=()=>setZoom(1);
canvas.addEventListener('wheel',e=>{ e.preventDefault(); zoomBy(Math.exp(-e.deltaY*0.0015)); },{passive:false});

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
  if(e.target.tagName==='INPUT') return;
  if(e.key==='h'||e.key==='H') app.classList.toggle('collapsed');
  else if(e.key==='f'||e.key==='F') toggleFs();
  else if(e.key>='1'&&e.key<='9'&&+e.key<=presets.length) selectPreset(+e.key-1);
  else if(e.key==='ArrowRight') selectPreset(active+1);
  else if(e.key==='ArrowLeft') selectPreset(active-1);
  else if(e.key==='+'||e.key==='=') zoomBy(1.15);
  else if(e.key==='-'||e.key==='_') zoomBy(1/1.15);
  else if(e.key==='0') setZoom(1);
});

// resize
addEventListener('resize',()=>{ sizeRenderer(); presets.forEach(p=>p.resize()); });

// request microphone and start listening on first load
startMic();

// start the render loop now that every DOM reference and preset is initialized
loop();
