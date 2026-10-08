// AI あまね 流体オーブ（WebGL / 依存なし）
//  - レイマーチングで描く、ノイズで脈打つ液体金属のようなコア
//  - 低音=大きなうねり / 中音=波打ち / 高音=細かなさざ波
//  - 周囲に音声スペクトルのリングとHUDリング
window.AmaneOrb = (() => {
  "use strict";

  const VERT = `attribute vec2 p; void main(){ gl_Position = vec4(p, 0.0, 1.0); }`;

  const FRAG = `
precision highp float;
uniform vec2 uRes;
uniform float uTime, uLevel, uBass, uMid, uHigh, uEnergy, uPulse, uWork;
uniform vec3 uColA, uColB;
uniform sampler2D uSpec;

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
}

mat3 rotY(float a){float c=cos(a),s=sin(a);return mat3(c,0.,-s, 0.,1.,0., s,0.,c);}
mat3 rotX(float a){float c=cos(a),s=sin(a);return mat3(1.,0.,0., 0.,c,s, 0.,-s,c);}

float map(vec3 p){
  float t = uTime;
  vec3 q = rotY(t*0.15) * rotX(t*0.11) * p;
  float n1 = snoise(q*0.95 + vec3(0.0, t*0.28, t*0.19));
  float n2 = snoise(q*2.10 + vec3(t*0.42, 0.0, -t*0.33) + n1*0.35);
  float n3 = snoise(q*4.60 + vec3(0.0, -t*0.95, t*0.70));
  float disp = n1*(0.030 + 0.030*uEnergy + uBass*0.15)
             + n2*(0.008 + 0.010*uEnergy + uMid*0.070)
             + n3*(0.0015 + uHigh*0.026);
  float r = 0.74 + uLevel*0.07 + uPulse*0.04;
  return length(p) - r - disp;
}

vec3 calcNormal(vec3 p){
  const vec2 k = vec2(1.0,-1.0); const float e = 0.0025;
  return normalize(k.xyy*map(p+k.xyy*e) + k.yyx*map(p+k.yyx*e) + k.yxy*map(p+k.yxy*e) + k.xxx*map(p+k.xxx*e));
}

void main(){
  float m = min(uRes.x, uRes.y);
  vec2 uv = (gl_FragCoord.xy - vec2(0.5*uRes.x, 0.60*uRes.y)) / m * 1.45;
  float r = length(uv);
  float ang = atan(uv.x, uv.y);                 // 0 = 真上
  float a01 = abs(ang) / 3.14159265;           // 0(上)..1(下) 左右対称

  // ---- 背景 ----
  vec3 col = vec3(0.004, 0.006, 0.010);
  col += uColB * 0.12 * exp(-r*2.6) * (0.5 + uLevel*1.6 + uEnergy*0.3);

  // ---- スペクトルリング ----
  float s = texture2D(uSpec, vec2(0.02 + a01*0.96, 0.5)).r;
  float R0 = 0.405;
  float Rr = R0 + 0.004 + s*0.085*(0.35 + uEnergy*0.65);
  float seg = step(0.38, fract(a01*72.0));
  float bars = smoothstep(R0, R0+0.003, r) * (1.0 - smoothstep(Rr-0.002, Rr, r)) * seg;
  float edge = exp(-abs(r - Rr) * 260.0);
  vec3 ringCol = mix(uColA, vec3(1.0), 0.25);
  col += ringCol * (bars*0.22*(0.4+s) + edge*0.55*(0.3+s));

  // ---- HUDリング（目盛り） ----
  float a2 = (ang + 3.14159265) / 6.2831853;
  float hud = exp(-abs(r - 0.528) * 700.0) * 0.28;
  float ticks = step(0.86, fract(a2*120.0 + uTime*0.6)) * smoothstep(0.016, 0.0, abs(r - 0.544)) * 0.35;
  float major = step(0.93, fract(a2*12.0 - uTime*0.04)) * smoothstep(0.024, 0.0, abs(r - 0.548)) * 0.5;
  col += mix(uColA, vec3(0.8), 0.5) * (hud + ticks + major) * (0.5 + 0.5*uEnergy);

  // ---- 作業中インジケーター（回転するアーク） ----
  float arc = step(0.55, fract(a2*4.0 - uTime*0.35)) * exp(-abs(r - 0.512) * 420.0);
  float arc2 = step(0.8, fract(a2*9.0 + uTime*0.6)) * exp(-abs(r - 0.498) * 600.0);
  col += vec3(1.0, 0.68, 0.22) * (arc*0.9 + arc2*0.5) * uWork;

  // ---- コア（レイマーチング） ----
  vec3 ro = vec3(0.0, 0.0, 3.0);
  vec3 rd = normalize(vec3(uv, -1.15));
  float b = dot(ro, rd); float c = dot(ro, ro) - 1.55*1.55; float h = b*b - c;
  if (h > 0.0) {
    float t = -b - sqrt(h); float tEnd = -b + sqrt(h);
    float glow = 0.0; bool hit = false;
    for (int i = 0; i < 64; i++) {
      vec3 p = ro + rd*t;
      float d = map(p);
      glow += exp(-max(d, 0.0)*7.0) * 0.012;
      if (d < 0.0015) { hit = true; break; }
      t += d * 0.72;
      if (t > tEnd) break;
    }
    col += uColA * glow * (0.35 + uLevel*1.8 + uEnergy*0.25);
    if (hit) {
      vec3 p = ro + rd*t;
      vec3 n = calcNormal(p);
      vec3 v = -rd;
      float ndv = max(dot(n, v), 0.0);
      float fres = pow(1.0 - ndv, 2.6);
      vec3 irid = 0.5 + 0.5*cos(6.2831853*(vec3(0.55, 0.65, 0.80) + ndv*0.9 + n.y*0.25 + uTime*0.03));
      // 表面を流れる2色のグラデーション
      float cn = snoise(p*1.4 + vec3(0.0, uTime*0.22, uTime*0.15));
      vec3 flowCol = mix(uColA, uColB, smoothstep(-0.6, 0.6, cn));
      vec3 sc = flowCol * 0.07;
      sc += flowCol * pow(ndv, 2.0) * (0.20 + uLevel*0.45);           // 内側から光るコア
      sc += mix(flowCol, irid, 0.25) * fres * (1.5 + uLevel*0.8);     // 縁の発光
      vec3 l = normalize(vec3(0.5, 0.8, 0.6));
      float spec = pow(max(dot(n, normalize(l + v)), 0.0), 70.0);
      vec3 l2 = normalize(vec3(-0.7, -0.3, 0.4));
      float spec2 = pow(max(dot(n, normalize(l2 + v)), 0.0), 30.0);
      sc += vec3(1.0)*spec*1.1 + uColB*spec2*0.5;
      sc += uColA * pow(ndv, 5.0) * (0.15 + uLevel*0.5);
      sc *= 0.70 + uEnergy*0.45;
      col = sc + uColA * glow * 0.25;
    }
  }

  // ビネットとトーンマップ
  col *= 1.0 - smoothstep(0.55, 1.2, r) * 0.6;
  col = col / (1.0 + col*0.35);
  col = pow(col, vec3(0.92));
  gl_FragColor = vec4(col, 1.0);
}`;

  const PALETTES = {
    idle:       { a: [0.42, 0.48, 0.58], b: [0.16, 0.18, 0.26], energy: 0.12 },
    standby:    { a: [0.25, 0.72, 1.00], b: [0.12, 0.22, 0.75], energy: 0.40 },
    connecting: { a: [0.75, 0.97, 1.00], b: [0.25, 0.55, 1.00], energy: 0.75 },
    listening:  { a: [0.20, 1.00, 0.86], b: [0.12, 0.42, 1.00], energy: 0.80 },
    speaking:   { a: [0.30, 0.86, 1.00], b: [0.82, 0.25, 1.00], energy: 1.00 },
    working:    { a: [1.00, 0.72, 0.25], b: [0.95, 0.25, 0.42], energy: 0.55 },
    thinking:   { a: [0.70, 0.60, 1.00], b: [0.20, 0.85, 1.00], energy: 0.70 },
  };
  const BINS = 64;

  let gl, prog, canvas, tex, U = {};
  let state = "idle", working = false, rawBins = null;
  const spec = new Float32Array(BINS);
  const specBytes = new Uint8Array(BINS);
  const cur = { a: [...PALETTES.idle.a], b: [...PALETTES.idle.b], energy: 0.12, level: 0, bass: 0, mid: 0, high: 0, work: 0 };
  let scale = 0.8, lastT = performance.now(), slowFrames = 0, t0 = performance.now();

  function compile(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }

  function init(el) {
    canvas = el;
    gl = canvas.getContext("webgl", { antialias: false, alpha: false, powerPreference: "high-performance" });
    if (!gl) throw new Error("WebGL が使えません");
    prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    gl.useProgram(prog);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, "p");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    for (const n of ["uRes", "uTime", "uLevel", "uBass", "uMid", "uHigh", "uEnergy", "uPulse", "uWork", "uColA", "uColB", "uSpec"])
      U[n] = gl.getUniformLocation(prog, n);

    tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, BINS, 1, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, specBytes);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.uniform1i(U.uSpec, 0);

    requestAnimationFrame(frame);
  }

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.floor(canvas.clientWidth * dpr * scale));
    const h = Math.max(1, Math.floor(canvas.clientHeight * dpr * scale));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    gl.viewport(0, 0, w, h);
  }

  // 生の周波数データ（0-255）を 64 本に間引き・平滑化
  function updateSpectrum() {
    const src = rawBins;
    for (let i = 0; i < BINS; i++) {
      let v = 0;
      if (src && src.length) {
        // 声の帯域を広く見せるため、低域寄りに対数っぽくマッピング
        const f0 = Math.floor(Math.pow(i / BINS, 1.6) * src.length * 0.7);
        const f1 = Math.max(f0 + 1, Math.floor(Math.pow((i + 1) / BINS, 1.6) * src.length * 0.7));
        for (let k = f0; k < f1; k++) v = Math.max(v, src[k] || 0);
        v /= 255;
      }
      const prev = spec[i];
      spec[i] = v > prev ? prev + (v - prev) * 0.55 : prev + (v - prev) * 0.12; // 速く立ち上がり、ゆっくり落ちる
      specBytes[i] = Math.min(255, spec[i] * 255);
    }
  }
  const avg = (a, b) => { let s = 0; for (let i = a; i < b; i++) s += spec[i]; return s / (b - a); };
  const lerp = (a, b, k) => a + (b - a) * k;

  function frame(now) {
    const dt = now - lastT; lastT = now;
    // 重いPCでは自動で解像度を下げる
    if (dt > 28) { if (++slowFrames > 30 && scale > 0.45) { scale -= 0.1; slowFrames = 0; } } else slowFrames = Math.max(0, slowFrames - 1);

    resize();
    updateSpectrum();

    const key = working && (state === "idle" || state === "standby") ? "working" : state;
    const P = PALETTES[key] || PALETTES.idle;
    // フレームレートに依存しない平滑化
    const k = (ms) => 1 - Math.exp(-Math.min(dt, 200) / ms);
    for (let i = 0; i < 3; i++) { cur.a[i] = lerp(cur.a[i], P.a[i], k(350)); cur.b[i] = lerp(cur.b[i], P.b[i], k(350)); }
    cur.energy = lerp(cur.energy, P.energy, k(450));
    cur.bass = lerp(cur.bass, Math.min(1, avg(0, 8) * 1.3), k(50));
    cur.mid = lerp(cur.mid, Math.min(1, avg(8, 28) * 1.6), k(50));
    cur.high = lerp(cur.high, Math.min(1, avg(28, 64) * 2.4), k(50));
    cur.level = lerp(cur.level, Math.min(1, avg(0, 40) * 1.5), k(60));
    cur.work = lerp(cur.work, working ? 1 : 0, k(350));

    const t = (now - t0) / 1000;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, BINS, 1, gl.LUMINANCE, gl.UNSIGNED_BYTE, specBytes);
    gl.uniform2f(U.uRes, canvas.width, canvas.height);
    gl.uniform1f(U.uTime, t);
    gl.uniform1f(U.uLevel, cur.level);
    gl.uniform1f(U.uBass, cur.bass);
    gl.uniform1f(U.uMid, cur.mid);
    gl.uniform1f(U.uHigh, cur.high);
    gl.uniform1f(U.uEnergy, cur.energy);
    gl.uniform1f(U.uPulse, state === "connecting" ? 0.5 + 0.5 * Math.sin(t * 9) : state === "thinking" ? 0.35 + 0.35 * Math.sin(t * 5) : 0);
    gl.uniform1f(U.uWork, cur.work);
    gl.uniform3fv(U.uColA, cur.a);
    gl.uniform3fv(U.uColB, cur.b);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    requestAnimationFrame(frame);
  }

  return {
    init,
    setState(s) { state = s; },
    setWorking(w) { working = Boolean(w); },
    setBins(b) { rawBins = b; },
  };
})();
