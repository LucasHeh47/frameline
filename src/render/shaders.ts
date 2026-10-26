// The GLSL behind the picture: placing a clip in the frame (Motion), blending layers, every video
// effect and transition. Pictures are premultiplied; color work happens on un-premultiplied color.

const HEAD = `#version 300 es
precision highp float;
precision highp sampler3D;
in vec2 vUv;
out vec4 o;
uniform vec2 uSize;
vec3 unpre(vec4 c) { return c.a > 0.00001 ? c.rgb / c.a : vec3(0.0); }
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec3 rgb2hsl(vec3 c) {
  float mx = max(c.r, max(c.g, c.b)), mn = min(c.r, min(c.g, c.b));
  float l = (mx + mn) * 0.5, h = 0.0, s = 0.0, d = mx - mn;
  if (d > 0.00001) {
    s = l > 0.5 ? d / (2.0 - mx - mn) : d / (mx + mn);
    if (mx == c.r) h = (c.g - c.b) / d + (c.g < c.b ? 6.0 : 0.0);
    else if (mx == c.g) h = (c.b - c.r) / d + 2.0;
    else h = (c.r - c.g) / d + 4.0;
    h /= 6.0;
  }
  return vec3(h, s, l);
}
float hue2rgb(float p, float q, float t) {
  t = fract(t);
  if (t < 1.0 / 6.0) return p + (q - p) * 6.0 * t;
  if (t < 0.5) return q;
  if (t < 2.0 / 3.0) return p + (q - p) * (2.0 / 3.0 - t) * 6.0;
  return p;
}
vec3 hsl2rgb(vec3 h) {
  if (h.y <= 0.0) return vec3(h.z);
  float q = h.z < 0.5 ? h.z * (1.0 + h.y) : h.z + h.y - h.z * h.y;
  float p = 2.0 * h.z - q;
  return vec3(hue2rgb(p, q, h.x + 1.0 / 3.0), hue2rgb(p, q, h.x), hue2rgb(p, q, h.x - 1.0 / 3.0));
}
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
`;

/** A color effect: `fx(rgb, uv)` changes the un-premultiplied color. */
const colorFx = (uniforms: string, body: string) => `${HEAD}
uniform sampler2D uTex;
${uniforms}
vec3 fx(vec3 c, vec2 uv) {
${body}
}
void main() {
  vec4 s = texture(uTex, vUv);
  if (s.a <= 0.0) { o = vec4(0.0); return; }
  vec3 c = clamp(fx(unpre(s), vUv), 0.0, 1.0);
  o = vec4(c * s.a, s.a);
}`;

/** Draws a source picture into clip space, turning it upright when the file says it's rotated. */
export const SOURCE = `${HEAD}
uniform sampler2D uTex;
uniform int uRot;
uniform bool uOpaque;
void main() {
  vec2 uv = vUv;
  if (uRot == 1) uv = vec2(1.0 - vUv.y, vUv.x);
  else if (uRot == 2) uv = 1.0 - vUv;
  else if (uRot == 3) uv = vec2(vUv.y, 1.0 - vUv.x);
  vec4 c = texture(uTex, uv);
  o = uOpaque ? vec4(c.rgb, 1.0) : c;
}`;

export const SOLID = `${HEAD}
uniform vec4 uColor;
void main() { o = uColor; }`;

/** Places a clip in the frame: uInv maps a frame pixel to the clip's uv. Edges are antialiased. */
export const PLACE = `${HEAD}
uniform sampler2D uTex;
uniform mat3 uInv;
uniform vec2 uClipPx;
uniform float uOpacity;
void main() {
  vec3 q = uInv * vec3(gl_FragCoord.xy, 1.0);
  vec2 uv = q.xy;
  vec2 e = min(uv, 1.0 - uv) * uClipPx;
  float a = clamp(min(e.x, e.y) + 0.5, 0.0, 1.0);
  if (a <= 0.0) { o = vec4(0.0); return; }
  o = texture(uTex, clamp(uv, 0.0, 1.0)) * a * uOpacity;
}`;

/** Layers a picture over the ones below with a blend mode (W3C compositing). */
export const BLEND = `${HEAD}
uniform sampler2D uBase;
uniform sampler2D uLayer;
uniform int uMode;
float soft(float b, float s) {
  if (s <= 0.5) return b - (1.0 - 2.0 * s) * b * (1.0 - b);
  float d = b <= 0.25 ? ((16.0 * b - 12.0) * b + 4.0) * b : sqrt(b);
  return b + (2.0 * s - 1.0) * (d - b);
}
vec3 mode(vec3 b, vec3 s) {
  if (uMode == 1) return b * s;
  if (uMode == 2) return b + s - b * s;
  if (uMode == 3) return mix(2.0 * b * s, 1.0 - 2.0 * (1.0 - b) * (1.0 - s), step(0.5, b));
  if (uMode == 4) return min(b + s, 1.0);
  if (uMode == 5) return min(b, s);
  if (uMode == 6) return max(b, s);
  if (uMode == 7) return abs(b - s);
  if (uMode == 8) return vec3(soft(b.r, s.r), soft(b.g, s.g), soft(b.b, s.b));
  if (uMode == 9) return mix(2.0 * b * s, 1.0 - 2.0 * (1.0 - b) * (1.0 - s), step(0.5, s));
  if (uMode == 10) return min(b / max(1.0 - s, 0.00001), 1.0);
  if (uMode == 11) return 1.0 - min((1.0 - b) / max(s, 0.00001), 1.0);
  return s;
}
void main() {
  vec4 b = texture(uBase, vUv);
  vec4 s = texture(uLayer, vUv);
  if (uMode == 0 || s.a <= 0.0) { o = s + b * (1.0 - s.a); return; }
  vec3 cb = unpre(b), cs = unpre(s);
  vec3 c = (1.0 - b.a) * s.rgb + (1.0 - s.a) * b.rgb + s.a * b.a * mode(cb, cs);
  o = vec4(c, s.a + b.a * (1.0 - s.a));
}`;

export const BLEND_INDEX: Record<string, number> = { normal: 0, multiply: 1, screen: 2, overlay: 3, add: 4, darken: 5, lighten: 6, difference: 7, softLight: 8, hardLight: 9, colorDodge: 10, colorBurn: 11 };

/** Mixes two pictures (adjustment layers' opacity). */
export const MIX = `${HEAD}
uniform sampler2D uA;
uniform sampler2D uB;
uniform float uT;
void main() { o = mix(texture(uA, vUv), texture(uB, vUv), uT); }`;

// ---------- color ----------

export const LUMETRI = colorFx(
  `uniform float uTemp, uTint, uExposure, uContrast, uHighlights, uShadows, uWhites, uBlacks, uSaturation, uVibrance, uFaded;
uniform float uLutAmount, uLutSize;
uniform sampler3D uLut;
uniform float uVignette, uVigMid, uVigRound, uVigFeather;
uniform vec2 uAspect;`,
  `  // White balance
  c *= vec3(1.0 + uTemp * 0.25, 1.0 - uTint * 0.2, 1.0 - uTemp * 0.25);
  // Exposure in stops, on linear light
  c = pow(pow(max(c, 0.0), vec3(2.2)) * exp2(uExposure), vec3(1.0 / 2.2));
  // Contrast around the middle
  float k = uContrast > 0.0 ? 1.0 + uContrast * 1.2 : 1.0 + uContrast * 0.8;
  c = (c - 0.5) * k + 0.5;
  float l = luma(clamp(c, 0.0, 1.0));
  c += uHighlights * 0.35 * smoothstep(0.45, 1.0, l);
  c += uShadows * 0.35 * (1.0 - smoothstep(0.0, 0.55, l));
  c += uWhites * 0.25 * l * l;
  c += uBlacks * 0.18 * (1.0 - l) * (1.0 - l);
  l = luma(clamp(c, 0.0, 1.0));
  c = mix(vec3(l), c, uSaturation);
  float sat = max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b));
  c = mix(vec3(l), c, 1.0 + uVibrance * (1.0 - clamp(sat, 0.0, 1.0)));
  c = mix(c, c * 0.82 + 0.12, uFaded);
  if (uLutAmount > 0.0) {
    vec3 p = clamp(c, 0.0, 1.0) * ((uLutSize - 1.0) / uLutSize) + 0.5 / uLutSize;
    c = mix(c, texture(uLut, p).rgb, uLutAmount);
  }
  if (uVignette != 0.0) {
    vec2 d = (uv - 0.5) * mix(uAspect, vec2(1.0), 0.5 - uVigRound * 0.5) * 2.0;
    float r = length(d);
    float v = smoothstep(uVigMid * 1.4 - uVigFeather * 0.5, uVigMid * 1.4 + uVigFeather * 0.7, r);
    c = uVignette < 0.0 ? c * (1.0 + uVignette * 0.33 * v) : mix(c, vec3(1.0), uVignette * 0.33 * v);
  }
  return c;`,
);

export const BRIGHTNESS = colorFx('uniform float uBrightness, uContrast;', '  return (c - 0.5) * (1.0 + uContrast) + 0.5 + uBrightness * 0.5;');

export const HSL = colorFx(
  'uniform float uHue, uSat, uLight;',
  `  vec3 h = rgb2hsl(c);
  h.x = fract(h.x + uHue);
  h.y = clamp(h.y * (1.0 + uSat), 0.0, 1.0);
  h.z = uLight >= 0.0 ? mix(h.z, 1.0, uLight) : h.z * (1.0 + uLight);
  return hsl2rgb(h);`,
);

export const BLACK_WHITE = colorFx('uniform float uAmount;', '  return mix(c, vec3(luma(c)), uAmount);');
export const SEPIA = colorFx('uniform float uAmount;', '  vec3 s = vec3(dot(c, vec3(0.393, 0.769, 0.189)), dot(c, vec3(0.349, 0.686, 0.168)), dot(c, vec3(0.272, 0.534, 0.131)));\n  return mix(c, s, uAmount);');
export const TINT = colorFx('uniform vec3 uBlack, uWhite; uniform float uAmount;', '  return mix(c, mix(uBlack, uWhite, luma(c)), uAmount);');
export const INVERT = colorFx('uniform float uAmount;', '  return mix(c, 1.0 - c, uAmount);');
export const POSTERIZE = colorFx('uniform float uLevels;', '  return floor(c * uLevels + 0.5) / uLevels;');
export const NOISE = colorFx(
  'uniform float uAmount, uSeed; uniform bool uColor;',
  `  vec2 p = uv * uSize + uSeed;
  vec3 n = uColor ? vec3(hash(p), hash(p + 17.0), hash(p + 31.0)) : vec3(hash(p));
  return c + (n - 0.5) * uAmount;`,
);

// ---------- blur, sharpen, glow ----------

/** One direction of a gaussian blur (run twice). uStep is one texel in the blur's direction. */
export const BLUR = `${HEAD}
uniform sampler2D uTex;
uniform vec2 uStep;
uniform float uSigma;
void main() {
  if (uSigma < 0.3) { o = texture(uTex, vUv); return; }
  int r = int(min(ceil(uSigma * 2.5), 40.0));
  vec4 sum = vec4(0.0);
  float wsum = 0.0;
  for (int i = -40; i <= 40; i++) {
    if (i < -r || i > r) continue;
    float w = exp(-float(i * i) / (2.0 * uSigma * uSigma));
    sum += texture(uTex, vUv + uStep * float(i)) * w;
    wsum += w;
  }
  o = sum / wsum;
}`;

export const SHARPEN = `${HEAD}
uniform sampler2D uTex;
uniform float uAmount;
void main() {
  vec2 t = 1.0 / uSize;
  vec4 c = texture(uTex, vUv);
  vec4 n = texture(uTex, vUv + vec2(t.x, 0.0)) + texture(uTex, vUv - vec2(t.x, 0.0)) + texture(uTex, vUv + vec2(0.0, t.y)) + texture(uTex, vUv - vec2(0.0, t.y));
  vec4 s = c + (c * 4.0 - n) * uAmount;
  o = vec4(clamp(s.rgb, 0.0, s.a), c.a);
}`;

export const BRIGHT_PASS = `${HEAD}
uniform sampler2D uTex;
uniform float uThreshold;
void main() {
  vec4 c = texture(uTex, vUv);
  float l = luma(unpre(c));
  o = c * smoothstep(uThreshold, uThreshold + 0.15, l);
}`;

/** Adds a glow (or any picture) on top: uBase + uAdd × uIntensity. */
export const ADD = `${HEAD}
uniform sampler2D uBase;
uniform sampler2D uAdd;
uniform float uIntensity;
void main() {
  vec4 b = texture(uBase, vUv);
  vec4 a = texture(uAdd, vUv) * uIntensity;
  o = vec4(min(b.rgb + a.rgb, max(b.a, a.a)), max(b.a, min(1.0, a.a)));
}`;

// ---------- keying, crop, mask, flip, mosaic ----------

export const ULTRA_KEY = `${HEAD}
uniform sampler2D uTex;
uniform vec3 uKey;
uniform float uTolerance, uSoftness, uSpill, uChoke;
vec2 cbcr(vec3 c) { return vec2(-0.1687 * c.r - 0.3313 * c.g + 0.5 * c.b, 0.5 * c.r - 0.4187 * c.g - 0.0813 * c.b); }
void main() {
  vec4 s = texture(uTex, vUv);
  vec3 c = unpre(s);
  float d = distance(cbcr(c), cbcr(uKey));
  float t = uTolerance * 0.3;
  float a = smoothstep(t, t + 0.005 + uSoftness * 0.25, d);
  a = clamp((a - uChoke) / max(1.0 - uChoke, 0.001), 0.0, 1.0);
  // Spill: take back the key color's tint from the edges
  int k = uKey.g >= uKey.b && uKey.g >= uKey.r ? 1 : (uKey.b >= uKey.r ? 2 : 0);
  if (k == 1) c.g = mix(c.g, min(c.g, max(c.r, c.b)), uSpill);
  else if (k == 2) c.b = mix(c.b, min(c.b, max(c.r, c.g)), uSpill);
  else c.r = mix(c.r, min(c.r, max(c.g, c.b)), uSpill);
  float oa = s.a * a;
  o = vec4(c * oa, oa);
}`;

export const LUMA_KEY = `${HEAD}
uniform sampler2D uTex;
uniform float uThreshold, uSoftness;
uniform bool uInvert;
void main() {
  vec4 s = texture(uTex, vUv);
  float l = luma(unpre(s));
  if (uInvert) l = 1.0 - l;
  float a = smoothstep(uThreshold, uThreshold + 0.002 + uSoftness * 0.5, l);
  o = s * a;
}`;

export const CROP = `${HEAD}
uniform sampler2D uTex;
uniform vec4 uCrop;
uniform float uFeather;
void main() {
  vec2 p = vUv * uSize;
  float l = uCrop.x * uSize.x, r = (1.0 - uCrop.z) * uSize.x;
  float b = uCrop.w * uSize.y, t = (1.0 - uCrop.y) * uSize.y;
  float f = max(uFeather, 0.5);
  float a = clamp((p.x - l) / f + 0.5, 0.0, 1.0) * clamp((r - p.x) / f + 0.5, 0.0, 1.0) * clamp((p.y - b) / f + 0.5, 0.0, 1.0) * clamp((t - p.y) / f + 0.5, 0.0, 1.0);
  o = texture(uTex, vUv) * a;
}`;

export const MASK = `${HEAD}
uniform sampler2D uTex;
uniform vec2 uCenter;
uniform vec2 uHalf;
uniform float uFeather;
uniform bool uEllipse, uInvert;
void main() {
  vec2 p = vUv * uSize;
  vec2 c = uCenter * uSize, hs = max(uHalf * uSize, vec2(0.5));
  float f = max(uFeather * min(uSize.x, uSize.y) * 0.25, 0.75);
  float a;
  if (uEllipse) {
    vec2 d = (p - c) / hs;
    float r = length(d);
    float edge = (r - 1.0) * min(hs.x, hs.y);
    a = clamp(0.5 - edge / f, 0.0, 1.0);
  } else {
    vec2 d = abs(p - c) - hs;
    float edge = max(d.x, d.y);
    a = clamp(0.5 - edge / f, 0.0, 1.0);
  }
  if (uInvert) a = 1.0 - a;
  o = texture(uTex, vUv) * a;
}`;

export const FLIP = `${HEAD}
uniform sampler2D uTex;
uniform bool uH, uV;
void main() {
  vec2 uv = vUv;
  if (uH) uv.x = 1.0 - uv.x;
  if (uV) uv.y = 1.0 - uv.y;
  o = texture(uTex, uv);
}`;

export const MOSAIC = `${HEAD}
uniform sampler2D uTex;
uniform float uBlocks;
void main() {
  float bx = uBlocks;
  float by = max(1.0, floor(uBlocks * uSize.y / uSize.x + 0.5));
  vec2 cell = vec2(bx, by);
  vec2 uv = (floor(vUv * cell) + 0.5) / cell;
  o = texture(uTex, uv);
}`;

/** A drop shadow: the blurred alpha (uShadow), offset and colored, under the picture. */
export const SHADOW = `${HEAD}
uniform sampler2D uTex;
uniform sampler2D uShadow;
uniform vec2 uOffset;
uniform vec4 uColor;
void main() {
  vec4 c = texture(uTex, vUv);
  float sa = texture(uShadow, vUv - uOffset / uSize).a;
  vec4 s = uColor * sa;
  o = c + s * (1.0 - c.a);
}`;

// ---------- transitions ----------

/** uA → uB as uP goes 0 → 1. Either side may be empty (a fade from or to nothing). */
export const TRANSITION = `${HEAD}
uniform sampler2D uA;
uniform sampler2D uB;
uniform float uP;
uniform int uType;
uniform int uDir;
uniform float uSoft;
uniform bool uHasA, uHasB;
vec4 A(vec2 uv) { return uHasA && uv.x >= 0.0 && uv.y >= 0.0 && uv.x <= 1.0 && uv.y <= 1.0 ? texture(uA, uv) : vec4(0.0); }
vec4 B(vec2 uv) { return uHasB && uv.x >= 0.0 && uv.y >= 0.0 && uv.x <= 1.0 && uv.y <= 1.0 ? texture(uB, uv) : vec4(0.0); }
vec2 dirv() { return uDir == 0 ? vec2(-1.0, 0.0) : uDir == 1 ? vec2(1.0, 0.0) : uDir == 2 ? vec2(0.0, 1.0) : vec2(0.0, -1.0); }
void main() {
  vec2 uv = vUv;
  float p = clamp(uP, 0.0, 1.0);
  if (uType == 1 || uType == 2) {
    // Dip to black / white: the color shows in full at the middle
    vec4 dip = uType == 1 ? vec4(0.0, 0.0, 0.0, 1.0) : vec4(1.0);
    vec4 a = uHasA ? A(uv) : dip;
    vec4 b = uHasB ? B(uv) : dip;
    o = p < 0.5 ? mix(a, dip, p * 2.0) : mix(dip, b, p * 2.0 - 1.0);
    return;
  }
  if (uType == 3) {
    // Wipe: a soft edge travels across
    vec2 d = dirv();
    float x = d.x != 0.0 ? (d.x < 0.0 ? 1.0 - uv.x : uv.x) : (d.y > 0.0 ? uv.y : 1.0 - uv.y);
    float s = max(uSoft, 0.001);
    float m = 1.0 - smoothstep(p * (1.0 + s) - s, p * (1.0 + s), x);
    o = mix(A(uv), B(uv), m);
    return;
  }
  if (uType == 4) {
    vec2 c = (uv - 0.5) * vec2(uSize.x / uSize.y, 1.0);
    float r = length(c);
    float maxR = length(vec2(uSize.x / uSize.y, 1.0)) * 0.5;
    float s = max(uSoft, 0.001);
    float m = 1.0 - smoothstep(p * (maxR + s) - s, p * (maxR + s), r);
    o = mix(A(uv), B(uv), m);
    return;
  }
  if (uType == 5) {
    // Slide: the next clip comes in over the first
    vec2 d = dirv();
    vec4 b = B(uv + d * (1.0 - p));
    o = b + A(uv) * (1.0 - b.a);
    return;
  }
  if (uType == 6) {
    vec2 d = dirv();
    vec4 b = B(uv + d * (1.0 - p));
    vec4 a = A(uv - d * p);
    o = b + a * (1.0 - b.a);
    return;
  }
  if (uType == 7) {
    // Cross zoom
    float z = p < 0.5 ? 1.0 + p * 4.0 : 1.0 + (1.0 - p) * 4.0;
    vec2 zuv = (uv - 0.5) / z + 0.5;
    float m = smoothstep(0.35, 0.65, p);
    o = mix(A(zuv), B(zuv), m);
    return;
  }
  o = mix(A(uv), B(uv), p);
}`;

export const TRANSITION_INDEX: Record<string, number> = { crossDissolve: 0, dipToBlack: 1, dipToWhite: 2, wipe: 3, iris: 4, slide: 5, push: 6, zoom: 7, blurDissolve: 0 };
export const DIRECTION_INDEX: Record<string, number> = { left: 0, right: 1, up: 2, down: 3 };
