// AI あまね 粒子の群れ（WebGL / 依存なし）
//  形のある物体ではなく、空間に漂う数万の光の粒が「そこに何かいる」気配をつくる。
//  - 粒子の動きはすべて GPU（頂点シェーダー）で計算
//  - 低音=群れ全体のうねり / 中音=中心から広がる波紋 / 声の帯域ごとに外側へ押し出す
//  - 背景には空間の奥行きを感じさせる光の糸（フィラメント）。1 本ずつ高さ・傾き・曲がり・奥行きが違い、ゆっくりうねる
//  - 粒は中心の雲 → そのまわりの広がり → 画面いっぱいに散らばる粒、と外へ行くほど薄くなる
//  - 光る線でできた多面体（幾何学的な 3D 物体）が、雲を包み、そのまわりを漂う
//  - setFocus("right" | "left" | "center") で、資料のパネルをよける（右に出したら左へ、左なら右へ、中央なら後ろで小さく）
window.AmaneSwarm = (() => {
  "use strict";

  const NOISE = `
// 3D simplex noise: webgl-noise (MIT) Copyright (C) 2011 Ashima Arts / Stefan Gustavson
// https://github.com/ashima/webgl-noise  （ライセンス全文は THIRD_PARTY_NOTICES.md）
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
  float n_=0.142857142857; vec3 ns=n_*D.wyz-D.xzx;
  vec4 j=p-49.0*floor(p*ns.z*ns.z); vec4 x_=floor(j*ns.z); vec4 y_=floor(j-7.0*x_);
  vec4 x=x_*ns.x+ns.yyyy; vec4 y=y_*ns.x+ns.yyyy; vec4 h=1.0-abs(x)-abs(y);
  vec4 b0=vec4(x.xy,y.xy); vec4 b1=vec4(x.zw,y.zw);
  vec4 s0=floor(b0)*2.0+1.0; vec4 s1=floor(b1)*2.0+1.0; vec4 sh=-step(h,vec4(0.0));
  vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy; vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
  vec3 p0=vec3(a0.xy,h.x); vec3 p1=vec3(a0.zw,h.y); vec3 p2=vec3(a1.xy,h.z); vec3 p3=vec3(a1.zw,h.w);
  vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
  p0*=norm.x; p1*=norm.y; p2*=norm.z; p3*=norm.w;
  vec4 m=max(0.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.0); m=m*m;
  return 42.0*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
}`;

  // 共通: 3D→画面（簡易パースペクティブ）
  const PROJECT = `
uniform float uAspect, uScale;
uniform vec2 uCenter;
vec4 project(vec3 p, out float depth){
  vec3 c = p * uScale; c.z -= 4.2;
  depth = -c.z;
  float f = 2.1;
  vec2 ndc = vec2(c.x * f / uAspect, c.y * f) / depth + uCenter;
  return vec4(ndc, 0.0, 1.0);
}`;

  // ---- 背景（深い空間と床のほのかな光） ----
  const BG_VS = `attribute vec2 p; varying vec2 vUv; void main(){ vUv = p; gl_Position = vec4(p, 0.0, 1.0); }`;
  const BG_FS = `
precision mediump float;
varying vec2 vUv;
uniform vec3 uColA, uColB;
uniform float uLevel, uEnergy, uAspect;
uniform vec2 uCenter;
void main(){
  vec2 uv = vUv;
  vec3 col = mix(vec3(0.004, 0.008, 0.016), vec3(0.010, 0.020, 0.040), smoothstep(-1.0, 0.6, uv.y));
  // 群れの後ろのにじみ
  vec2 d = (uv - uCenter) * vec2(uAspect * 0.55, 1.0);
  col += uColB * 0.10 * exp(-dot(d, d) * 1.4) * (0.4 + uEnergy * 0.5 + uLevel * 0.5);
  // 床の反射光
  vec2 f = (uv - vec2(uCenter.x, -0.92)) * vec2(uAspect * 0.45, 3.2);
  col += uColA * 0.05 * exp(-dot(f, f)) * (0.5 + uLevel);
  // ビネット
  col *= 1.0 - 0.45 * smoothstep(0.6, 1.6, length(uv * vec2(1.0, 1.2)));
  gl_FragColor = vec4(col, 1.0);
}`;

  // ---- 光の糸（太さのある発光ライン。画面の幅いっぱいに張る） ----
  // 1 本ずつ高さ・傾き・曲がり・奥行き・明るさを変え、ゆっくりうねる流れに乗せる（規則正しく並ばないように）
  const LINE_VS = `
attribute vec4 aSeg;    // x: 何本目か(0..1)  y,z: 線分の両端の位置(-1..1)  w: どちらの端か(0/1)
attribute float aSide;  // 線の左右(-1/1)
uniform float uTime, uLevel, uBass, uEnergy;
uniform vec2 uRes;
uniform float uHalfW;
varying float vA, vSide;
${NOISE}
${PROJECT}
float hash(float n){ return fract(sin(n) * 43758.5453); }
vec3 curve(float id, float u){
  float h1 = hash(id * 91.7), h2 = hash(id * 37.3 + 1.3), h3 = hash(id * 53.9 + 2.7), h4 = hash(id * 17.1 + 4.1), h5 = hash(id * 71.3 + 5.9);
  float x = u * (2.6 + 2.2 * uAspect);             // 横長の画面でも端まで届く長さ
  float y = (h1 * 2.0 - 1.0) * 2.5                 // 画面の上から下まで、ばらばらの高さ
          + (h2 * 2.0 - 1.0) * 0.55 * u            // 少し斜め
          + (h3 * 2.0 - 1.0) * 0.7 * (u * u - 0.33); // 弧の向きと強さもばらばら
  y *= 0.6 + 0.4 * u * u;                          // 中央（群れのあたり）へ、気持ちすぼまる
  // ゆっくりうねる流れ（線ごとに違う）と、声に合わせた細かい揺れ
  y += 0.22 * snoise(vec3(u * (0.5 + h4 * 1.1), id * 9.0, uTime * 0.045)) * (1.0 + uBass * 1.5);
  y += 0.03 * sin(u * 5.0 + uTime * 0.6 + id * 37.0) * (uLevel * 5.0 + uBass * 3.0);
  float z = -1.0 - h5 * 2.0 + 0.45 * snoise(vec3(u * 0.6, id * 5.0, uTime * 0.03));
  return vec3(x, y, z);
}
void main(){
  float id = aSeg.x;
  float d0, d1;
  vec4 a = project(curve(id, aSeg.y), d0);
  vec4 b = project(curve(id, aSeg.z), d1);
  vec2 dir = normalize((b.xy - a.xy) * uRes + 1e-6);
  vec2 n = vec2(-dir.y, dir.x);
  vec4 p = aSeg.w < 0.5 ? a : b;
  p.xy += n * aSide * uHalfW * 2.0 / uRes;
  gl_Position = p;
  vSide = aSide;
  float u = aSeg.w < 0.5 ? aSeg.y : aSeg.z;
  // 線ごとに明るさを変え、ゆっくり濃くなったり薄くなったりする。端は消えるように
  float glowK = 0.45 + 0.55 * hash(id * 13.7 + 7.7);
  float breathe = 0.7 + 0.3 * sin(uTime * (0.07 + 0.08 * hash(id * 3.3)) + id * 40.0);
  vA = (0.32 + 0.06 * uEnergy + uLevel * 0.08) * glowK * breathe * smoothstep(1.0, 0.55, abs(u));
}`;
  const LINE_FS = `
precision mediump float;
varying float vA, vSide;
uniform vec3 uColA;
void main(){
  // 太い帯の中に、白く細い芯・明るいにじみ・遠くまで広がる淡い光を重ねて、強く発光して見せる
  float d = abs(vSide);
  float core = exp(-d * d * 120.0) * 1.1;  // 芯
  float glow = exp(-d * d * 10.0) * 0.75;  // にじみ
  float halo = exp(-d * 2.4) * 0.38;       // 遠くまで広がる光
  vec3 c = uColA * (glow + halo) + mix(uColA, vec3(0.92, 0.98, 1.0), 0.6) * core;   // にじみは色付き、芯は白っぽく
  gl_FragColor = vec4(c * vA, 1.0);
}`;

  // ---- 多面体（光る線でできた幾何学的な 3D 物体） ----
  const GEO_N = 12;  // 物体の数（1 つ目は雲を包む大きなもの）
  const GEO_VS = `
attribute vec3 aA, aB;     // 辺の両端（大きさ 1 の形）
attribute vec3 aInfo;      // x: 何個目の物体か  y: どちらの端か(0/1)  z: 線の左右(-1/1)
uniform vec3 uObjPos[${GEO_N}], uObjRot[${GEO_N}];
uniform float uObjSize[${GEO_N}], uObjGlow[${GEO_N}];
uniform vec2 uRes;
uniform float uHalfW;
varying float vA, vSide;
${PROJECT}
mat3 rot(vec3 r){
  float cx = cos(r.x), sx = sin(r.x), cy = cos(r.y), sy = sin(r.y), cz = cos(r.z), sz = sin(r.z);
  mat3 X = mat3(1., 0., 0., 0., cx, sx, 0., -sx, cx);
  mat3 Y = mat3(cy, 0., -sy, 0., 1., 0., sy, 0., cy);
  mat3 Z = mat3(cz, sz, 0., -sz, cz, 0., 0., 0., 1.);
  return Z * Y * X;
}
void main(){
  int i = int(aInfo.x + 0.5);
  mat3 R = rot(uObjRot[i]);
  float d0, d1;
  vec4 a = project(uObjPos[i] + R * aA * uObjSize[i], d0);
  vec4 b = project(uObjPos[i] + R * aB * uObjSize[i], d1);
  vec2 dir = normalize((b.xy - a.xy) * uRes + 1e-6);
  vec2 n = vec2(-dir.y, dir.x);
  vec4 p = aInfo.y < 0.5 ? a : b;
  float depth = aInfo.y < 0.5 ? d0 : d1;
  p.xy += n * aInfo.z * uHalfW * 2.0 / uRes;
  gl_Position = p;
  vSide = aInfo.z;
  vA = uObjGlow[i] * clamp(4.6 / depth, 0.4, 1.3);   // 奥のものほど暗く
}`;

  // ---- 粒子 ----
  const PT_VS = `
attribute vec3 aBase;
attribute vec4 aSeed;   // x,y: 色と明るさのばらつき  z: 0.75以上は空間に散らばる粒  w: 大きさ
uniform float uTime, uLevel, uBass, uMid, uHigh, uEnergy, uThink, uWork, uPx;
uniform vec3 uColA, uColB;
uniform sampler2D uSpec;
varying vec3 vCol;
varying float vAlpha, vBlur;
${NOISE}
${PROJECT}
mat3 rotY(float a){ float c = cos(a), s = sin(a); return mat3(c, 0., -s, 0., 1., 0., s, 0., c); }
void main(){
  float t = uTime;
  float wide = step(0.75, aSeed.z);
  vec3 p = aBase;
  if (wide > 0.5) p.x *= max(1.0, uAspect / 1.4);   // 横長の画面でも端まで散らばる

  // ゆっくり流れる（考え中・作業中は速く渦を巻く）
  float sp = 0.10 + 0.18 * uEnergy + uThink * 0.35 + uWork * 0.15;
  vec3 q = p * (wide > 0.5 ? 0.45 : 1.25) + aSeed.xyz * 0.2;
  vec3 flow = vec3(snoise(q + vec3(t * sp, 0.0, 0.0)), snoise(q + vec3(13.1, t * sp, 0.0)), snoise(q + vec3(0.0, 7.7, t * sp)));
  float amp = mix(0.10 + 0.10 * uEnergy + uBass * 0.40, 0.28 + uBass * 0.2, wide);
  p += flow * amp;

  // 群れの中心は回転し、考え中は渦が速くなる
  if (wide < 0.5) p = rotY(t * (0.06 + uThink * 0.5) + length(p) * (0.6 + uThink * 1.5)) * p;

  // 声の帯域ごとに外側へ押し出す（話している方向に膨らむ）
  float r = length(p.xy);
  float a01 = abs(atan(p.x, p.y)) / 3.14159265;
  float s = texture2D(uSpec, vec2(0.02 + a01 * 0.96, 0.5)).r;
  float push = s * (0.42 * (0.3 + uEnergy)) * smoothstep(0.05, 0.9, r) * (1.0 - wide * 0.8);
  p.xy *= 1.0 + push;
  // 中心から広がる波紋
  p *= 1.0 + uMid * 0.10 * sin(length(p) * 10.0 - t * 7.0) * (1.0 - wide);
  // 全体の呼吸
  p *= 1.0 + 0.03 * sin(t * 0.8) + uLevel * 0.10 * (1.0 - wide);

  // 群れは横長の雲のかたちに
  if (wide < 0.5) p *= vec3(1.55, 0.95, 1.0);

  float depth;
  gl_Position = project(p, depth);
  // ピント（被写界深度）は群れの中心（depth 4.2）に合わせる。
  // 奥の粒は小さくぼけ、中央はくっきり、手前は少しだけ大きく少しぼける
  float dz = depth - 4.2;
  float blur = dz > 0.0 ? clamp((dz - 0.25) * 0.8, 0.0, 1.0) : clamp((-dz - 0.25) * 0.5, 0.0, 0.6);
  float grow = dz > 0.0 ? 1.0 + blur * 0.3 : 1.0 + blur * 0.8;
  gl_PointSize = uPx * (0.35 + aSeed.w * 1.1) * (4.2 / depth) * grow * (1.0 + uLevel * 0.3 + s * 0.35);
  vBlur = blur;

  float core = exp(-dot(aBase, aBase) * 1.6) * (1.0 - wide);
  vCol = mix(uColB, uColA, clamp(aSeed.x * 0.6 + core * 0.8 + s * 0.4, 0.0, 1.0));
  vCol = mix(vCol, vec3(0.9, 0.95, 1.0), core * 0.3 + s * 0.1);
  vAlpha = (0.55 + 1.00 * core + uLevel * 0.12 + s * 0.22) * (0.40 + aSeed.y * 0.9) * (0.55 + 0.30 * uEnergy);
  vAlpha *= mix(1.0, 0.85, wide);
  vAlpha *= 0.75 + 0.25 * sin(t * (1.5 + aSeed.w * 3.0) + aSeed.x * 40.0); // またたき
  vAlpha /= 1.0 + blur * 1.4;   // ぼけるほど光が広がって薄くなる
}`;
  // ピントが合っている粒は、くっきりした小さな丸と明るい芯。ぼけるほど、なめらかに広がる丸になる
  const PT_FS = `
precision mediump float;
varying vec3 vCol;
varying float vAlpha, vBlur;
void main(){
  float d = length(gl_PointCoord - 0.5) * 2.0;      // 中心 0、ふち 1
  float sharp = (1.0 - smoothstep(0.7, 0.95, d)) * 0.35 + exp(-d * d * 14.0);
  float soft = exp(-d * d * 3.0) * (1.0 - smoothstep(0.85, 1.0, d)) * 0.8;
  float a = mix(sharp, soft, vBlur);
  gl_FragColor = vec4(vCol * a * vAlpha, 1.0);
}`;

  const PALETTES = {
    idle:       { a: [0.40, 0.60, 0.85], b: [0.10, 0.18, 0.40], energy: 0.32 },
    standby:    { a: [0.35, 0.70, 1.00], b: [0.08, 0.20, 0.60], energy: 0.45 },
    connecting: { a: [0.70, 0.92, 1.00], b: [0.20, 0.45, 1.00], energy: 0.80 },
    listening:  { a: [0.40, 0.95, 1.00], b: [0.06, 0.32, 0.85], energy: 0.80 },
    speaking:   { a: [0.55, 0.85, 1.00], b: [0.15, 0.35, 1.00], energy: 1.00 },
    thinking:   { a: [0.70, 0.65, 1.00], b: [0.25, 0.25, 0.90], energy: 0.75 },
    working:    { a: [1.00, 0.78, 0.40], b: [0.55, 0.22, 0.50], energy: 0.55 },
  };
  const BINS = 64;

  let gl, canvas, progs = {}, bufs = {}, tex, nPts = 0, nLineVerts = 0, nGeoVerts = 0;
  let state = "idle", working = false, focus = false, rawBins = null;
  const spec = new Float32Array(BINS), specBytes = new Uint8Array(BINS);
  const cur = { a: [...PALETTES.idle.a], b: [...PALETTES.idle.b], energy: 0.15, level: 0, bass: 0, mid: 0, high: 0, work: 0, think: 0, cx: 0, cy: 0.12, scale: 1 };
  let scale = 1, lastT = performance.now(), slow = 0, t0 = performance.now();

  function compile(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }
  function program(vs, fs, uniforms, attribs) {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    const o = { p, u: {}, a: {} };
    uniforms.forEach((n) => { o.u[n] = gl.getUniformLocation(p, n); });
    attribs.forEach((n) => { o.a[n] = gl.getAttribLocation(p, n); });
    return o;
  }
  function buffer(data) { const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW); return b; }

  // ガウス分布っぽい乱数（中心が濃い雲にする）
  const gauss = () => { let s = 0; for (let i = 0; i < 4; i++) s += Math.random(); return (s - 2) / 1.1; };

  function buildParticles(n) {
    const base = new Float32Array(n * 3), seed = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      const kind = Math.random();
      const near = kind < 0.03;
      const wide = kind < 0.35;
      if (near) {           // 手前を漂う少しの粒（少し大きく、少しぼける）
        base[i * 3] = (Math.random() * 2 - 1) * 2.2;
        base[i * 3 + 1] = (Math.random() * 2 - 1) * 1.4;
        base[i * 3 + 2] = 1.0 + Math.random() * 1.4;
      } else if (wide) {    // 画面いっぱいに散らばる粒（奥の空間のような広がり）
        base[i * 3] = (Math.random() * 2 - 1) * 3.6;
        base[i * 3 + 1] = (Math.random() * 2 - 1) * 2.5;
        base[i * 3 + 2] = -0.4 - Math.random() * 2.2;
      } else {              // 中心の雲（6 割）と、そのまわりへの広がり（4 割）。外へ行くほど薄くなる
        const r = kind < 0.61 ? 1.25 : 0.78;
        base[i * 3] = gauss() * r; base[i * 3 + 1] = gauss() * r; base[i * 3 + 2] = gauss() * r * 0.8;
      }
      seed[i * 4] = Math.random(); seed[i * 4 + 1] = Math.random();
      seed[i * 4 + 2] = wide ? 0.75 + Math.random() * 0.25 : Math.random() * 0.74;
      seed[i * 4 + 3] = Math.pow(Math.random(), 2);
    }
    bufs.base = buffer(base); bufs.seed = buffer(seed); nPts = n;
  }
  function buildLines(lines = 24, segs = 120) {
    const seg = [], side = [];
    for (let l = 0; l < lines; l++) {
      const id = (l + 0.5) / lines;
      for (let s = 0; s < segs; s++) {
        const u0 = -1 + (2 * s) / segs, u1 = -1 + (2 * (s + 1)) / segs;
        // 2 つの三角形で 1 本の線分を太さのある帯にする
        for (const [w, sd] of [[0, -1], [0, 1], [1, -1], [1, -1], [0, 1], [1, 1]]) { seg.push(id, u0, u1, w); side.push(sd); }
      }
    }
    bufs.lineSeg = buffer(new Float32Array(seg)); bufs.lineSide = buffer(new Float32Array(side)); nLineVerts = side.length;
  }

  // 多面体の頂点（大きさ 1）。辺は、いちばん近い頂点どうしを結ぶ
  const PHI = (1 + Math.sqrt(5)) / 2;
  const SHAPES = {
    tetra: [[1, 1, 1], [1, -1, -1], [-1, 1, -1], [-1, -1, 1]],
    octa: [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]],
    cube: [-1, 1].flatMap((x) => [-1, 1].flatMap((y) => [-1, 1].map((z) => [x, y, z]))),
    icosa: [[-1, PHI], [1, PHI], [-1, -PHI], [1, -PHI]].flatMap(([a, b]) => [[0, a, b], [a, b, 0], [b, 0, a]]),
    dodeca: [
      ...[-1, 1].flatMap((x) => [-1, 1].flatMap((y) => [-1, 1].map((z) => [x, y, z]))),
      ...[-1, 1].flatMap((a) => [-1, 1].flatMap((b) => [[0, a / PHI, b * PHI], [a / PHI, b * PHI, 0], [a * PHI, 0, b / PHI]])),
    ],
    cubocta: [-1, 1].flatMap((a) => [-1, 1].flatMap((b) => [[a, b, 0], [a, 0, b], [0, a, b]])),
  };
  function edgesOf(verts) {
    const unitV = verts.map((v) => { const l = Math.hypot(...v); return v.map((x) => x / l); });
    const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    let min = Infinity;
    for (let i = 0; i < unitV.length; i++) for (let j = i + 1; j < unitV.length; j++) min = Math.min(min, dist(unitV[i], unitV[j]));
    const out = [];
    for (let i = 0; i < unitV.length; i++) for (let j = i + 1; j < unitV.length; j++) if (dist(unitV[i], unitV[j]) < min * 1.01) out.push([unitV[i], unitV[j]]);
    return out;
  }
  // 物体ごとの形と動き。1 つ目は雲を包む大きな正二十面体、ほかはまわりを漂う小さなもの
  //  orbit: 回る半径(横, 縦)・速さ・位相・奥行き  size: 大きさ  spin: 自転の速さ  glow: 明るさ
  //  まわりの物体は、決まった乱数で配置する（開くたびに同じ景色になるように）
  const seeded = (seed) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const rnd = seeded(7);
  const SMALL_SHAPES = ["octa", "tetra", "cube", "dodeca", "icosa", "cubocta"];
  const OBJECTS = [
    { shape: "icosa", orbit: [0, 0, 0, 0, 0], size: 0.85, spin: [0.05, 0.08, 0.03], glow: 0.10 },
    ...Array.from({ length: GEO_N - 1 }, (_, k) => ({
      shape: SMALL_SHAPES[k % SMALL_SHAPES.length],
      orbit: [1.1 + rnd() * 1.8, 0.4 + rnd() * 1.0, (rnd() < 0.5 ? -1 : 1) * (0.025 + rnd() * 0.05), rnd() * 6.283, -1.4 + rnd() * 2.0],
      size: 0.05 + rnd() * 0.06,
      spin: [0.2 + rnd() * 0.6, 0.2 + rnd() * 0.6, 0.1 + rnd() * 0.5],
      glow: 0.45 + rnd() * 0.2,
    })),
  ];
  function buildGeometry() {
    const A = [], B = [], info = [];
    OBJECTS.forEach((o, k) => {
      for (const [a, b] of edgesOf(SHAPES[o.shape])) {
        // 2 つの三角形で 1 本の辺を太さのある帯にする
        for (const [w, sd] of [[0, -1], [0, 1], [1, -1], [1, -1], [0, 1], [1, 1]]) { A.push(...a); B.push(...b); info.push(k, w, sd); }
      }
    });
    bufs.geoA = buffer(new Float32Array(A)); bufs.geoB = buffer(new Float32Array(B)); bufs.geoInfo = buffer(new Float32Array(info));
    nGeoVerts = info.length / 3;
  }
  // 今の時刻での、物体の位置・向き・大きさ・明るさ（声に合わせて少し膨らみ、明るくなる。考え中は速く回る）
  function geometryState(t) {
    const pos = [], rotv = [], size = [], glow = [];
    const spinK = 1 + cur.think * 3 + cur.work;
    OBJECTS.forEach((o) => {
      const [rx, ry, sp, ph, z] = o.orbit;
      const a = t * sp + ph;
      pos.push(Math.cos(a) * rx, Math.sin(a * 1.3) * ry, z + Math.sin(a) * 0.5);
      rotv.push(t * o.spin[0] * spinK, t * o.spin[1] * spinK, t * o.spin[2] * spinK);
      size.push(o.size * (1 + cur.level * 0.25 + cur.bass * 0.15));
      glow.push(o.glow * (0.6 + 0.4 * cur.energy + cur.level * 0.4));
    });
    return { pos, rotv, size, glow };
  }

  function init(el) {
    canvas = el;
    gl = canvas.getContext("webgl", { antialias: false, alpha: false, powerPreference: "high-performance" });
    if (!gl) throw new Error("WebGL が使えません");
    const common = ["uAspect", "uScale", "uCenter", "uTime", "uLevel", "uBass", "uMid", "uHigh", "uEnergy", "uColA", "uColB"];
    progs.bg = program(BG_VS, BG_FS, ["uColA", "uColB", "uLevel", "uEnergy", "uAspect", "uCenter"], ["p"]);
    progs.line = program(LINE_VS, LINE_FS, [...common, "uRes", "uHalfW"], ["aSeg", "aSide"]);
    progs.pt = program(PT_VS, PT_FS, [...common, "uThink", "uWork", "uPx", "uSpec"], ["aBase", "aSeed"]);
    progs.geo = program(GEO_VS, LINE_FS, [...common, "uRes", "uHalfW", "uObjPos", "uObjRot", "uObjSize", "uObjGlow"], ["aA", "aB", "aInfo"]);
    bufs.quad = buffer(new Float32Array([-1, -1, 3, -1, -1, 3]));
    const mobile = Math.min(window.innerWidth, window.innerHeight) < 700;
    buildParticles(mobile ? 5000 : 9000);
    buildLines();
    buildGeometry();

    tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, BINS, 1, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, specBytes);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    requestAnimationFrame(frame);
  }

  function updateSpectrum() {
    const src = rawBins;
    for (let i = 0; i < BINS; i++) {
      let v = 0;
      if (src && src.length) {
        const f0 = Math.floor(Math.pow(i / BINS, 1.6) * src.length * 0.7);
        const f1 = Math.max(f0 + 1, Math.floor(Math.pow((i + 1) / BINS, 1.6) * src.length * 0.7));
        for (let k = f0; k < f1; k++) v = Math.max(v, src[k] || 0);
        v /= 255;
      }
      spec[i] = v > spec[i] ? spec[i] + (v - spec[i]) * 0.55 : spec[i] + (v - spec[i]) * 0.10;
      specBytes[i] = Math.min(255, spec[i] * 255);
    }
  }
  const avg = (a, b) => { let s = 0; for (let i = a; i < b; i++) s += spec[i]; return s / (b - a); };
  const lerp = (a, b, k) => a + (b - a) * k;

  function setCommon(o, t, aspect) {
    const u = o.u;
    if (u.uAspect) gl.uniform1f(u.uAspect, aspect);
    if (u.uScale) gl.uniform1f(u.uScale, cur.scale);
    if (u.uCenter) gl.uniform2f(u.uCenter, cur.cx, cur.cy);
    if (u.uTime) gl.uniform1f(u.uTime, t);
    if (u.uLevel) gl.uniform1f(u.uLevel, cur.level);
    if (u.uBass) gl.uniform1f(u.uBass, cur.bass);
    if (u.uMid) gl.uniform1f(u.uMid, cur.mid);
    if (u.uHigh) gl.uniform1f(u.uHigh, cur.high);
    if (u.uEnergy) gl.uniform1f(u.uEnergy, cur.energy);
    if (u.uColA) gl.uniform3fv(u.uColA, cur.a);
    if (u.uColB) gl.uniform3fv(u.uColB, cur.b);
  }
  function resetAttrs() { for (let i = 0; i < 4; i++) gl.disableVertexAttribArray(i); }
  function bindAttr(loc, buf, size) {
    if (loc < 0) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
  }

  function frame(now) {
    const dt = Math.min(200, now - lastT); lastT = now;
    if (dt > 30) { if (++slow > 40 && scale > 0.5) { scale -= 0.1; slow = 0; } } else slow = Math.max(0, slow - 1);

    const dpr = Math.min(window.devicePixelRatio || 1, 2) * scale;
    const w = Math.max(1, Math.floor(canvas.clientWidth * dpr)), h = Math.max(1, Math.floor(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    gl.viewport(0, 0, w, h);
    const aspect = w / h;

    updateSpectrum();
    const key = working && (state === "idle" || state === "standby") ? "working" : state;
    const P = PALETTES[key] || PALETTES.idle;
    const k = (ms) => 1 - Math.exp(-dt / ms);
    for (let i = 0; i < 3; i++) { cur.a[i] = lerp(cur.a[i], P.a[i], k(400)); cur.b[i] = lerp(cur.b[i], P.b[i], k(400)); }
    cur.energy = lerp(cur.energy, P.energy, k(500));
    cur.bass = lerp(cur.bass, Math.min(1, avg(0, 8) * 1.3), k(60));
    cur.mid = lerp(cur.mid, Math.min(1, avg(8, 28) * 1.6), k(60));
    cur.high = lerp(cur.high, Math.min(1, avg(28, 64) * 2.4), k(60));
    cur.level = lerp(cur.level, Math.min(1, avg(0, 40) * 1.5), k(70));
    cur.work = lerp(cur.work, working ? 1 : 0, k(500));
    cur.think = lerp(cur.think, state === "thinking" || state === "connecting" ? 1 : 0, k(400));
    // 資料を表示しているときは、パネルの反対側へ寄って小さくなる（中央に大きく出したときは、後ろで小さくなる）
    const narrow = aspect < 1.1;
    const center = focus === "center";
    const side = focus === "left" ? 1 : -1;
    cur.cx = lerp(cur.cx, focus && !narrow && !center ? side * 0.52 : 0, k(450));
    cur.cy = lerp(cur.cy, focus && !center ? (narrow ? 0.55 : 0.1) : 0.12, k(450));
    cur.scale = lerp(cur.scale, focus ? (center ? 0.5 : narrow ? 0.55 : 0.72) : 1, k(450));

    const t = (now - t0) / 1000;

    // 背景
    gl.disable(gl.BLEND);
    resetAttrs();
    gl.useProgram(progs.bg.p);
    setCommon(progs.bg, t, aspect);
    bindAttr(progs.bg.a.p, bufs.quad, 2);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // 加算合成で光を重ねる
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);

    resetAttrs();
    gl.useProgram(progs.line.p);
    setCommon(progs.line, t, aspect);
    gl.uniform1f(progs.line.u.uScale, 1);          // 光の糸は資料表示中も動かさない（空間そのもの）
    gl.uniform2f(progs.line.u.uCenter, 0, 0.12);
    gl.uniform2f(progs.line.u.uRes, w, h);
    gl.uniform1f(progs.line.u.uHalfW, (16.0 + cur.level * 3.0) * dpr);   // にじみを含めた帯の太さ（芯はその中の細い部分）
    bindAttr(progs.line.a.aSeg, bufs.lineSeg, 4);
    bindAttr(progs.line.a.aSide, bufs.lineSide, 1);
    gl.drawArrays(gl.TRIANGLES, 0, nLineVerts);

    // 多面体（群れと一緒に動く）
    resetAttrs();
    gl.useProgram(progs.geo.p);
    setCommon(progs.geo, t, aspect);
    const g = geometryState(t);
    gl.uniform2f(progs.geo.u.uRes, w, h);
    gl.uniform1f(progs.geo.u.uHalfW, (7.0 + cur.level * 2.0) * dpr);
    gl.uniform3fv(progs.geo.u.uObjPos, g.pos);
    gl.uniform3fv(progs.geo.u.uObjRot, g.rotv);
    gl.uniform1fv(progs.geo.u.uObjSize, g.size);
    gl.uniform1fv(progs.geo.u.uObjGlow, g.glow);
    bindAttr(progs.geo.a.aA, bufs.geoA, 3);
    bindAttr(progs.geo.a.aB, bufs.geoB, 3);
    bindAttr(progs.geo.a.aInfo, bufs.geoInfo, 3);
    gl.drawArrays(gl.TRIANGLES, 0, nGeoVerts);

    resetAttrs();
    gl.useProgram(progs.pt.p);
    setCommon(progs.pt, t, aspect);
    gl.uniform1f(progs.pt.u.uThink, cur.think);
    gl.uniform1f(progs.pt.u.uWork, cur.work);
    gl.uniform1f(progs.pt.u.uPx, 6.5 * dpr);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, BINS, 1, gl.LUMINANCE, gl.UNSIGNED_BYTE, specBytes);
    gl.uniform1i(progs.pt.u.uSpec, 0);
    bindAttr(progs.pt.a.aBase, bufs.base, 3);
    bindAttr(progs.pt.a.aSeed, bufs.seed, 4);
    gl.drawArrays(gl.POINTS, 0, nPts);

    requestAnimationFrame(frame);
  }

  return {
    init,
    setState(s) { state = s; },
    setWorking(w) { working = Boolean(w); },
    setBins(b) { rawBins = b; },
    setFocus(f) { focus = f === true ? "right" : f || false; },
  };
})();
