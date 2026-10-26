/**
 * The WebGL2 colour pass. A line-by-line mirror of ./math.ts (gradePixel); the tuning constants
 * come from the same K object so the GPU and the CPU reference stay identical.
 */
import { K } from './params';
import { COLOR_STAGE_GLSL } from './colorStageGlsl';

const f = (n: number) => {
  const s = String(n);
  return s.includes('.') || s.includes('e') ? s : `${s}.0`;
};

export const VERTEX_SHADER = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  // a_pos is 0..1 (uv, y down); clip space y is up
  v_uv = a_pos;
  gl_Position = vec4(a_pos.x * 2.0 - 1.0, 1.0 - a_pos.y * 2.0, 0.0, 1.0);
}`;

export const FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler3D;

in vec2 v_uv;
out vec4 outColor;

uniform sampler2D u_src;
uniform vec4 u_srcRect;      // crop in source uv: x, y, w, h
uniform float u_aspect;      // clip box width / height

uniform bool u_useLut;
uniform sampler3D u_lut;
uniform float u_lutSize;
uniform vec3 u_lutMin;
uniform vec3 u_lutMax;
uniform float u_lutIntensity;
uniform bool u_lutSkin;

uniform vec2 u_look;         // grayscale, sepia
uniform vec3 u_wb;           // temp, tint, exposure
uniform vec2 u_bc;           // brightness, contrast
uniform vec4 u_tone;         // shadows, highlights, whites, blacks
uniform float u_brilliance;
uniform bool u_useHsl;
uniform float u_hsl[24];
uniform float u_sat;
uniform bool u_useCurves;
uniform sampler2D u_curves;
uniform bool u_useWheels;
uniform vec3 u_lift;
uniform vec3 u_gain;
uniform vec3 u_gamma;
uniform vec3 u_offset;
uniform float u_lumMix;
uniform vec3 u_liftC;
uniform vec3 u_gainC;
uniform vec3 u_gammaC;
uniform vec3 u_offsetC;
uniform vec4 u_wheelY;       // master lift, gain, gamma, offset
uniform float u_fade;
uniform float u_sharpen;
uniform float u_clarity;
uniform float u_vignette;
uniform float u_grain;
uniform uint u_seed;

uniform int u_maskShape;     // 0 none, 1 linear, 2 mirror, 3 circle, 4 rectangle
uniform vec2 u_maskC;
uniform vec2 u_maskS;
uniform float u_maskRot;
uniform float u_maskFeather;
uniform float u_maskRound;
uniform bool u_maskInvert;

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

float luma(vec3 c) { return dot(c, LUMA); }

vec4 srcAt(vec2 uv) { return texture(u_src, u_srcRect.xy + uv * u_srcRect.zw); }

vec3 toLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));
}
vec3 toSrgb(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(max(c, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
}

vec3 rgbToHsv(vec3 c) {
  float mx = max(c.r, max(c.g, c.b));
  float mn = min(c.r, min(c.g, c.b));
  float d = mx - mn;
  float h = 0.0;
  if (d > 1e-6) {
    if (mx == c.r) h = mod((c.g - c.b) / d, 6.0);
    else if (mx == c.g) h = (c.b - c.r) / d + 2.0;
    else h = (c.r - c.g) / d + 4.0;
    h *= 60.0;
    if (h < 0.0) h += 360.0;
  }
  return vec3(h, mx > 1e-6 ? d / mx : 0.0, mx);
}

vec3 hslToRgb(float h, float s, float l) {
  float C = (1.0 - abs(2.0 * l - 1.0)) * s;
  float hp = mod(mod(h, 360.0) + 360.0, 360.0) / 60.0;
  float X = C * (1.0 - abs(mod(hp, 2.0) - 1.0));
  vec3 rgb;
  if (hp < 1.0) rgb = vec3(C, X, 0.0);
  else if (hp < 2.0) rgb = vec3(X, C, 0.0);
  else if (hp < 3.0) rgb = vec3(0.0, C, X);
  else if (hp < 4.0) rgb = vec3(0.0, X, C);
  else if (hp < 5.0) rgb = vec3(X, 0.0, C);
  else rgb = vec3(C, 0.0, X);
  return rgb + (l - C / 2.0);
}

float skinWeight(vec3 c) {
  vec3 hsv = rgbToHsv(c);
  float hh = hsv.x > 300.0 ? hsv.x - 360.0 : hsv.x;
  float hueW = 1.0 - smoothstep(0.0, 25.0, abs(hh - 25.0));
  float satW = smoothstep(0.1, 0.2, hsv.y) * (1.0 - smoothstep(0.6, 0.75, hsv.y));
  float valW = smoothstep(0.2, 0.35, hsv.z);
  return hueW * satW * valW;
}

vec3 applyLut(vec3 c) {
  vec3 t = clamp((c - u_lutMin) / (u_lutMax - u_lutMin), 0.0, 1.0);
  vec3 coord = (t * (u_lutSize - 1.0) + 0.5) / u_lutSize;
  vec3 o = texture(u_lut, coord).rgb;
  float k = u_lutIntensity * (u_lutSkin ? 1.0 - ${f(K.SKIN_PROTECT)} * skinWeight(c) : 1.0);
  return clamp(mix(c, o, k), 0.0, 1.0);
}

vec3 applyLook(vec3 c) {
  vec3 o = c;
  if (u_look.x > 0.0) {
    float a = 1.0 - u_look.x;
    o = vec3(
      (0.2126 + 0.7874 * a) * o.r + (0.7152 - 0.7152 * a) * o.g + (0.0722 - 0.0722 * a) * o.b,
      (0.2126 - 0.2126 * a) * o.r + (0.7152 + 0.2848 * a) * o.g + (0.0722 - 0.0722 * a) * o.b,
      (0.2126 - 0.2126 * a) * o.r + (0.7152 - 0.7152 * a) * o.g + (0.0722 + 0.9278 * a) * o.b);
  }
  if (u_look.y > 0.0) {
    float a = 1.0 - u_look.y;
    o = vec3(
      (0.393 + 0.607 * a) * o.r + (0.769 - 0.769 * a) * o.g + (0.189 - 0.189 * a) * o.b,
      (0.349 - 0.349 * a) * o.r + (0.686 + 0.314 * a) * o.g + (0.168 - 0.168 * a) * o.b,
      (0.272 - 0.272 * a) * o.r + (0.534 - 0.534 * a) * o.g + (0.131 + 0.869 * a) * o.b);
  }
  return clamp(o, 0.0, 1.0);
}

vec3 applyWbExposure(vec3 c) {
  if (u_wb == vec3(0.0)) return c;
  vec3 l = toLinear(c);
  float t = u_wb.x;
  float m = u_wb.y;
  if (t != 0.0 || m != 0.0) {
    vec3 g = vec3(1.0 + ${f(K.TEMP_GAIN)} * t + 0.5 * ${f(K.TINT_GAIN)} * m,
                  1.0 - ${f(K.TINT_GAIN)} * m,
                  1.0 - ${f(K.TEMP_GAIN)} * t + 0.5 * ${f(K.TINT_GAIN)} * m);
    float before = luma(l);
    vec3 w = l * g;
    float after = luma(w);
    l = w * (after > 1e-6 ? before / after : 1.0);
  }
  if (u_wb.z != 0.0) l *= exp2(u_wb.z * ${f(K.EXPOSURE_EV)});
  return clamp(toSrgb(max(l, vec3(0.0))), 0.0, 1.0);
}

vec3 applyBc(vec3 c) {
  vec3 o = c;
  if (u_bc.x != 0.0) o = pow(max(o, vec3(0.0)), vec3(exp2(-u_bc.x * ${f(K.BRIGHT_GAMMA)})));
  if (u_bc.y != 0.0) o = (o - 0.5) * (1.0 + u_bc.y * ${f(K.CONTRAST)}) + 0.5;
  return clamp(o, 0.0, 1.0);
}

vec3 applyTone(vec3 c) {
  if (u_tone == vec4(0.0) && u_brilliance == 0.0) return c;
  float Y = luma(c);
  float wS = Y * (1.0 - Y) * (1.0 - Y) * 6.75;
  float wH = Y * Y * (1.0 - Y) * 6.75;
  float d = ${f(K.SHADOWS)} * u_tone.x * wS
          + ${f(K.HIGHLIGHTS)} * u_tone.y * wH
          + ${f(K.WHITES)} * u_tone.z * Y * Y * Y
          + ${f(K.BLACKS)} * u_tone.w * (1.0 - Y) * (1.0 - Y) * (1.0 - Y)
          + ${f(K.BRILLIANCE)} * u_brilliance * (wS - wH);
  return clamp(c + d, 0.0, 1.0);
}

const float CENTRES[9] = float[9](0.0, 30.0, 60.0, 120.0, 180.0, 240.0, 270.0, 300.0, 360.0);

vec3 applyHsl(vec3 c) {
  float mx = max(c.r, max(c.g, c.b));
  float mn = min(c.r, min(c.g, c.b));
  float chromaW = smoothstep(0.02, 0.2, mx - mn);
  if (chromaW <= 0.0) return c;
  float l = (mx + mn) / 2.0;
  float d = mx - mn;
  float h = rgbToHsv(c).x;
  float s = d < 1e-6 ? 0.0 : clamp(d / (1.0 - abs(2.0 * l - 1.0) + 1e-6), 0.0, 1.0);
  float dh = 0.0, ds = 0.0, dl = 0.0;
  for (int i = 0; i < 8; i++) {
    if (h >= CENTRES[i] && h < CENTRES[i + 1]) {
      float t = (h - CENTRES[i]) / (CENTRES[i + 1] - CENTRES[i]);
      int j = (i + 1) % 8;
      dh = (1.0 - t) * u_hsl[i * 3] + t * u_hsl[j * 3];
      ds = (1.0 - t) * u_hsl[i * 3 + 1] + t * u_hsl[j * 3 + 1];
      dl = (1.0 - t) * u_hsl[i * 3 + 2] + t * u_hsl[j * 3 + 2];
    }
  }
  float h2 = h + dh * ${f(K.HSL_HUE_DEG)} * chromaW;
  float s2 = clamp(s * max(0.0, 1.0 + ds), 0.0, 1.0);
  float la = dl * ${f(K.HSL_LIGHT)} * chromaW;
  float l2 = clamp(la > 0.0 ? l + (1.0 - l) * la : l + l * la, 0.0, 1.0);
  return clamp(hslToRgb(h2, s2, l2), 0.0, 1.0);
}

vec3 applySat(vec3 c) {
  if (u_sat == 0.0) return c;
  float Y = luma(c);
  return clamp(Y + (c - Y) * (1.0 + u_sat), 0.0, 1.0);
}

vec3 applyCurves(vec3 c) {
  vec3 x = (clamp(c, 0.0, 1.0) * 255.0 + 0.5) / 256.0;
  return vec3(texture(u_curves, vec2(x.r, 0.5)).r, texture(u_curves, vec2(x.g, 0.5)).g, texture(u_curves, vec2(x.b, 0.5)).b);
}

vec3 applyWheels(vec3 c) {
  vec3 v = c + u_lift * (1.0 - c);
  v = v * u_gain;
  v = pow(max(v, vec3(0.0)), u_gamma);
  v = v + u_offset;
  v = clamp(v, 0.0, 1.0);
  if (!(u_lumMix > 0.0)) return v;
  // Lum Mix: chroma-only wheel per channel, then the master curve on the luma only
  vec3 ch = clamp(pow(max((c + u_liftC * (1.0 - c)) * u_gainC, vec3(0.0)), u_gammaC) + u_offsetC, 0.0, 1.0);
  float Y = luma(ch);
  float d = clamp(pow(max((Y + u_wheelY.x * (1.0 - Y)) * u_wheelY.y, 0.0), u_wheelY.z) + u_wheelY.w, 0.0, 1.0) - Y;
  return clamp(mix(v, ch + d, u_lumMix), 0.0, 1.0);
}

vec3 applyFade(vec3 c) {
  if (u_fade == 0.0) return c;
  return ${f(K.FADE_LIFT)} * u_fade + c * (1.0 - ${f(K.FADE_COMPRESS)} * u_fade);
}

float srcY(vec2 uv) { return luma(srcAt(uv).rgb); }

float detailSharpen(vec2 uv) {
  vec2 r = vec2(${f(K.SHARPEN_RADIUS)} / u_aspect, ${f(K.SHARPEN_RADIUS)});
  float avg = (srcY(uv + vec2(r.x, 0.0)) + srcY(uv - vec2(r.x, 0.0)) + srcY(uv + vec2(0.0, r.y)) + srcY(uv - vec2(0.0, r.y))) * 0.25;
  return srcY(uv) - avg;
}

float detailClarity(vec2 uv) {
  vec2 r = vec2(${f(K.CLARITY_RADIUS)} / u_aspect, ${f(K.CLARITY_RADIUS)});
  float sum = 0.0;
  for (int i = 0; i < 8; i++) {
    float a = float(i) * 0.7853981634;
    vec2 d = vec2(cos(a), sin(a)) * r;
    sum += srcY(uv + d) + srcY(uv + d * 0.5);
  }
  return srcY(uv) - sum / 16.0;
}

float vignetteFactor(vec2 uv) {
  float d = length((uv - 0.5) * 2.0) / 1.41421356237;
  return 1.0 - u_vignette * ${f(K.VIGNETTE)} * smoothstep(0.3, 1.0, d);
}

uint hash3(uvec3 v) {
  v = v * 1664525u + 1013904223u;
  v.x += v.y * v.z;
  v.y += v.z * v.x;
  v.z += v.x * v.y;
  v ^= v >> 16u;
  v.x += v.y * v.z;
  return v.x;
}

float grainNoise(vec2 uv) {
  uvec2 g = uvec2(floor(vec2(uv.x * u_aspect, uv.y) * ${f(K.GRAIN_CELLS)}));
  return float(hash3(uvec3(g, u_seed))) / 4294967296.0 - 0.5;
}

float maskAlpha(vec2 uv) {
  if (u_maskShape == 0) return 1.0;
  vec2 q = vec2((uv.x - 0.5 - u_maskC.x) * u_aspect, uv.y - 0.5 - u_maskC.y);
  float cs = cos(u_maskRot), sn = sin(u_maskRot);
  vec2 p = vec2(q.x * cs + q.y * sn, -q.x * sn + q.y * cs);
  float hw = u_maskS.x * u_aspect / 2.0;
  float hh = u_maskS.y / 2.0;
  float sd;
  if (u_maskShape == 1) sd = p.y;
  else if (u_maskShape == 2) sd = abs(p.y) - hh;
  else if (u_maskShape == 3) sd = (length(p / vec2(hw, hh)) - 1.0) * min(hw, hh);
  else {
    float rr = u_maskRound * min(hw, hh);
    vec2 d = abs(p) - vec2(hw, hh) + rr;
    sd = length(max(d, vec2(0.0))) + min(max(d.x, d.y), 0.0) - rr;
  }
  float a = u_maskFeather > 1e-4 ? 1.0 - smoothstep(-u_maskFeather / 2.0, u_maskFeather / 2.0, sd) : (sd <= 0.0 ? 1.0 : 0.0);
  return u_maskInvert ? 1.0 - a : a;
}

${COLOR_STAGE_GLSL}

void main() {
  vec4 src = srcAt(v_uv);
  vec3 orig = src.rgb;
  vec3 o = orig;
  if (u_useLut) o = applyLut(o);
  o = applyLook(o);
  o = applyWbExposure(o);
  o = applyBc(o);
  o = applyTone(o);
  if (u_useHsl) o = applyHsl(o);
  o = applySat(o);
  if (u_useCurves) o = applyCurves(o);
  if (u_useWheels) o = applyWheels(o);
  if (u_useColor) o = applyColorStage(o, v_uv);
  o = applyFade(o);
  if (u_sharpen > 0.0 || u_clarity > 0.0) {
    float Y = luma(o);
    float d = 0.0;
    if (u_sharpen > 0.0) d += ${f(K.SHARPEN)} * u_sharpen * detailSharpen(v_uv);
    if (u_clarity > 0.0) d += ${f(K.CLARITY)} * u_clarity * detailClarity(v_uv) * 4.0 * Y * (1.0 - Y);
    o = clamp(o + d, 0.0, 1.0);
  }
  if (u_vignette > 0.0) o *= vignetteFactor(v_uv);
  if (u_grain > 0.0) o = clamp(o + grainNoise(v_uv) * ${f(K.GRAIN)} * u_grain, 0.0, 1.0);
  float a = maskAlpha(v_uv);
  o = mix(orig, o, a);
  outColor = vec4(o * src.a, src.a);
}`;
