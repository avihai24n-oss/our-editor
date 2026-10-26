/**
 * GLSL of the Color page stage — a line-by-line mirror of ./colorStage.ts (applyColorStage), plus
 * the uniform upload. Pasted into the colour pass fragment shader (./shader.ts) before main(); it
 * uses the shader's luma / toLinear / toSrgb / rgbToHsv / detailClarity helpers.
 */
import { CK, type ColorStageParams } from './colorStage';
import { HSL_CURVE_SIZE } from './hslCurves';

const f = (n: number) => {
  const s = String(n);
  return s.includes('.') || s.includes('e') ? s : `${s}.0`;
};

export const COLOR_STAGE_GLSL = `
uniform bool u_useColor;
uniform int u_csCst;
uniform bool u_csUseWb;
uniform vec3 u_csWb;
uniform vec2 u_csContrast;   // contrast, pivot
uniform vec3 u_csTone;       // shadows, highlights, midtone detail
uniform bool u_csUseLog;
uniform vec3 u_csLogS;
uniform vec3 u_csLogM;
uniform vec3 u_csLogH;
uniform vec2 u_csLogRange;
uniform float u_csBoost;
uniform bool u_csUseMat;
uniform mat3 u_csMat;
uniform bool u_csUseCurves;
uniform sampler2D u_csCurves;
uniform bool u_csUseQual;
uniform vec4 u_qHue;
uniform vec4 u_qSat;
uniform vec4 u_qLum;
uniform vec3 u_qClean;       // invert, clean black, clean white
uniform int u_qWinShape;
uniform vec2 u_qWinC;
uniform vec2 u_qWinS;
uniform float u_qWinRot;
uniform float u_qWinFeather;
uniform float u_qWinRound;
uniform bool u_qWinInvert;
uniform vec3 u_qGain;
uniform float u_qContrast;
uniform mat3 u_qMat;
uniform bool u_qShowMatte;

float csLogc3Dec(float t) { return t > 0.149658 ? (pow(10.0, (t - 0.385537) / 0.24719) - 0.052272) / 5.555556 : (t - 0.092809) / 5.367655; }
float csLogc3Enc(float x) { return x > 0.010591 ? 0.24719 * log(5.555556 * x + 0.052272) / log(10.0) + 0.385537 : 5.367655 * x + 0.092809; }
float csSlog3Dec(float t) { return t >= 171.2102946929 / 1023.0 ? pow(10.0, (t * 1023.0 - 420.0) / 261.5) * 0.19 - 0.01 : (t * 1023.0 - 95.0) * 0.01125 / (171.2102946929 - 95.0); }
float csVlogDec(float t) { return t < 0.181 ? (t - 0.125) / 5.6 : pow(10.0, (t - 0.598206) / 0.241514) - 0.00873; }
vec3 csToneMap(vec3 x) { vec3 v = max(x, vec3(0.0)) * ${f(CK.TM_GAIN)}; return v * (1.0 + v / ${f(CK.TM_W2)}) / (1.0 + v); }

vec3 csApplyCst(vec3 c) {
  if (u_csCst == 4) return clamp(vec3(csLogc3Enc(toLinear(c).r), csLogc3Enc(toLinear(c).g), csLogc3Enc(toLinear(c).b)), 0.0, 1.0);
  vec3 l;
  if (u_csCst == 1) {
    l = vec3(csLogc3Dec(c.r), csLogc3Dec(c.g), csLogc3Dec(c.b));
    l = vec3(dot(vec3(1.617523, -0.537287, -0.080237), l), dot(vec3(-0.070573, 1.334613, -0.26404), l), dot(vec3(-0.021102, -0.226954, 1.248056), l));
  } else if (u_csCst == 2) l = vec3(csSlog3Dec(c.r), csSlog3Dec(c.g), csSlog3Dec(c.b));
  else l = vec3(csVlogDec(c.r), csVlogDec(c.g), csVlogDec(c.b));
  return toSrgb(clamp(csToneMap(l), 0.0, 1.0));
}

float csContrastCh(float v, float c, float p) {
  float x = clamp(v, 0.0, 1.0);
  return x < p ? p * pow(x / p, c) : 1.0 - (1.0 - p) * pow((1.0 - x) / (1.0 - p), c);
}
vec3 csContrast(vec3 o, float c, float p) { return vec3(csContrastCh(o.r, c, p), csContrastCh(o.g, c, p), csContrastCh(o.b, c, p)); }

vec3 csWbApply(vec3 c, vec3 g) { return clamp(toSrgb(max(toLinear(c) * g, vec3(0.0))), 0.0, 1.0); }

mat3 csHueMat(float deg) {
  float a = cos(radians(deg));
  float b = sin(radians(deg));
  // GLSL mat3 is column-major: columns are listed
  return mat3(
    0.2126 + 0.7874 * a - 0.2126 * b, 0.2126 - 0.2126 * a + 0.143 * b, 0.2126 - 0.2126 * a - 0.7874 * b,
    0.7152 - 0.7152 * a - 0.7152 * b, 0.7152 + 0.2848 * a + 0.14 * b, 0.7152 - 0.7152 * a + 0.7152 * b,
    0.0722 - 0.0722 * a + 0.9278 * b, 0.0722 - 0.0722 * a - 0.283 * b, 0.0722 + 0.9278 * a + 0.0722 * b);
}

vec3 csHslCurves(vec3 c) {
  float mx = max(c.r, max(c.g, c.b));
  float mn = min(c.r, min(c.g, c.b));
  float cw = smoothstep(0.02, 0.15, mx - mn);
  vec3 hsv = rgbToHsv(c);
  float Y = luma(c);
  vec3 hr = texture(u_csCurves, vec2(hsv.x / 360.0 + 0.5 / ${f(HSL_CURVE_SIZE)}, 0.25)).rgb;
  float ls = texture(u_csCurves, vec2((clamp(Y, 0.0, 1.0) * ${f(HSL_CURVE_SIZE - 1)} + 0.5) / ${f(HSL_CURVE_SIZE)}, 0.25)).a;
  float ss = texture(u_csCurves, vec2((clamp(hsv.y, 0.0, 1.0) * ${f(HSL_CURVE_SIZE - 1)} + 0.5) / ${f(HSL_CURVE_SIZE)}, 0.75)).r;
  vec3 rot = csHueMat((hr.r - 0.5) * 360.0 * cw) * c;
  float sat = (1.0 + (2.0 * hr.g - 1.0) * cw) * 2.0 * ls * 2.0 * ss;
  float yl = Y * exp2((2.0 * hr.b - 1.0) * cw);
  return clamp(yl + (rot - Y) * sat, 0.0, 1.0);
}

float csBand(float x, float lo, float hi, float soft) {
  return smoothstep(lo - soft - 1e-4, lo, x) * (1.0 - smoothstep(hi, hi + soft + 1e-4, x));
}

float csWindow(vec2 uv) {
  if (u_qWinShape == 0) return 1.0;
  vec2 q = vec2((uv.x - 0.5 - u_qWinC.x) * u_aspect, uv.y - 0.5 - u_qWinC.y);
  float cs = cos(u_qWinRot), sn = sin(u_qWinRot);
  vec2 p = vec2(q.x * cs + q.y * sn, -q.x * sn + q.y * cs);
  float hw = u_qWinS.x * u_aspect / 2.0;
  float hh = u_qWinS.y / 2.0;
  float sd;
  if (u_qWinShape == 1) sd = p.y;
  else if (u_qWinShape == 2) sd = abs(p.y) - hh;
  else if (u_qWinShape == 3) sd = (length(p / vec2(hw, hh)) - 1.0) * min(hw, hh);
  else {
    float rr = u_qWinRound * min(hw, hh);
    vec2 d = abs(p) - vec2(hw, hh) + rr;
    sd = length(max(d, vec2(0.0))) + min(max(d.x, d.y), 0.0) - rr;
  }
  float a = u_qWinFeather > 1e-4 ? 1.0 - smoothstep(-u_qWinFeather / 2.0, u_qWinFeather / 2.0, sd) : (sd <= 0.0 ? 1.0 : 0.0);
  return u_qWinInvert ? 1.0 - a : a;
}

float csMatte(vec3 k, vec2 uv) {
  vec3 hsv = rgbToHsv(k);
  float Y = luma(k);
  float m = 1.0;
  if (u_qHue.x > 0.5) {
    float d = abs(mod(hsv.x - u_qHue.y + 540.0, 360.0) - 180.0);
    float mx = max(k.r, max(k.g, k.b));
    float mn = min(k.r, min(k.g, k.b));
    m *= (1.0 - smoothstep(u_qHue.z, u_qHue.z + u_qHue.w + 1e-3, d)) * smoothstep(0.01, 0.06, mx - mn);
  }
  if (u_qSat.x > 0.5) m *= csBand(hsv.y, u_qSat.y, u_qSat.z, u_qSat.w);
  if (u_qLum.x > 0.5) m *= csBand(Y, u_qLum.y, u_qLum.z, u_qLum.w);
  if (u_qClean.x > 0.5) m = 1.0 - m;
  if (u_qClean.y > 0.0 || u_qClean.z > 0.0) m = clamp((m - u_qClean.y) / max(0.01, 1.0 - u_qClean.y - u_qClean.z), 0.0, 1.0);
  return m * csWindow(uv);
}

vec3 csSecondary(vec3 c) {
  vec3 o = csWbApply(c, u_qGain);
  if (abs(u_qContrast - 1.0) > 1e-5) o = csContrast(o, u_qContrast, ${f(CK.SEC_PIVOT)});
  return clamp(u_qMat * o, 0.0, 1.0);
}

vec3 applyColorStage(vec3 c, vec2 uv) {
  vec3 o = u_csCst > 0 ? csApplyCst(c) : c;
  vec3 keyIn = o;
  if (u_csUseWb) o = csWbApply(o, u_csWb);
  if (abs(u_csContrast.x - 1.0) > 1e-5) o = csContrast(o, u_csContrast.x, u_csContrast.y);
  if (u_csTone.x != 0.0 || u_csTone.y != 0.0) {
    float Y = luma(o);
    float d = ${f(CK.TONE_NORM)} * (${f(CK.SHADOWS)} * u_csTone.x * Y * pow(1.0 - Y, 3.0) + ${f(CK.HIGHLIGHTS)} * u_csTone.y * pow(Y, 3.0) * (1.0 - Y));
    o = clamp(o + d, 0.0, 1.0);
  }
  if (u_csTone.z != 0.0) {
    float Y = luma(o);
    o = clamp(o + ${f(CK.MID_DETAIL)} * u_csTone.z * detailClarity(uv) * 4.0 * Y * (1.0 - Y), 0.0, 1.0);
  }
  if (u_csUseLog) {
    float Y = luma(o);
    float wS = 1.0 - smoothstep(u_csLogRange.x - ${f(CK.LOG_SOFT)}, u_csLogRange.x + ${f(CK.LOG_SOFT)}, Y);
    float wH = smoothstep(u_csLogRange.y - ${f(CK.LOG_SOFT)}, u_csLogRange.y + ${f(CK.LOG_SOFT)}, Y);
    float wM = max(0.0, 1.0 - wS - wH);
    o = clamp(o + wS * u_csLogS + wM * u_csLogM + wH * u_csLogH, 0.0, 1.0);
  }
  if (u_csBoost != 0.0) {
    float mx = max(o.r, max(o.g, o.b));
    float mn = min(o.r, min(o.g, o.b));
    float s = mx > 1e-6 ? (mx - mn) / mx : 0.0;
    float k = max(0.0, 1.0 + ${f(CK.BOOST)} * u_csBoost * (1.0 - s));
    float Y = luma(o);
    o = clamp(Y + (o - Y) * k, 0.0, 1.0);
  }
  if (u_csUseMat) o = clamp(u_csMat * o, 0.0, 1.0);
  if (u_csUseCurves) o = csHslCurves(o);
  if (u_csUseQual) {
    float m = csMatte(keyIn, uv);
    if (u_qShowMatte) return vec3(m);
    if (m > 0.0) o = mix(o, csSecondary(o), m);
  }
  return o;
}
`;

type U = (name: string) => WebGLUniformLocation | null;

/** Texture unit of the HSL curves table. */
export const CS_CURVES_UNIT = 3;

/** Uploads the Color stage uniforms (and the HSL curves table into `curveTex` when its key changed). */
export function setColorStageUniforms(gl: WebGL2RenderingContext, u: U, p: ColorStageParams | null, curveTex: WebGLTexture, state: { key: string }): void {
  gl.uniform1i(u('u_useColor'), p ? 1 : 0);
  if (!p) return;
  gl.uniform1i(u('u_csCst'), p.cst);
  gl.uniform1i(u('u_csUseWb'), p.wb ? 1 : 0);
  if (p.wb) gl.uniform3fv(u('u_csWb'), p.wb);
  gl.uniform2f(u('u_csContrast'), p.contrast, p.pivot);
  gl.uniform3f(u('u_csTone'), p.shadows, p.highlights, p.midDetail);
  gl.uniform1i(u('u_csUseLog'), p.log ? 1 : 0);
  if (p.log) {
    gl.uniform3fv(u('u_csLogS'), p.log.s);
    gl.uniform3fv(u('u_csLogM'), p.log.m);
    gl.uniform3fv(u('u_csLogH'), p.log.h);
    gl.uniform2f(u('u_csLogRange'), p.log.low, p.log.high);
  }
  gl.uniform1f(u('u_csBoost'), p.boost);
  gl.uniform1i(u('u_csUseMat'), p.satHue ? 1 : 0);
  if (p.satHue) gl.uniformMatrix3fv(u('u_csMat'), true, p.satHue);
  gl.uniform1i(u('u_csUseCurves'), p.curves ? 1 : 0);
  gl.activeTexture(gl.TEXTURE0 + CS_CURVES_UNIT);
  gl.bindTexture(gl.TEXTURE_2D, curveTex);
  if (p.curves && p.curvesKey !== state.key) {
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, HSL_CURVE_SIZE, 2, 0, gl.RGBA, gl.FLOAT, p.curves);
    state.key = p.curvesKey;
  }
  const q = p.qual;
  gl.uniform1i(u('u_csUseQual'), q ? 1 : 0);
  if (q) {
    gl.uniform4fv(u('u_qHue'), q.hue);
    gl.uniform4fv(u('u_qSat'), q.sat);
    gl.uniform4fv(u('u_qLum'), q.lum);
    gl.uniform3f(u('u_qClean'), q.invert ? 1 : 0, q.cleanBlack, q.cleanWhite);
    const w = q.window;
    gl.uniform1i(u('u_qWinShape'), w ? w.shape : 0);
    if (w) {
      gl.uniform2f(u('u_qWinC'), w.cx, w.cy);
      gl.uniform2f(u('u_qWinS'), w.w, w.h);
      gl.uniform1f(u('u_qWinRot'), w.rot);
      gl.uniform1f(u('u_qWinFeather'), w.feather);
      gl.uniform1f(u('u_qWinRound'), w.roundness);
      gl.uniform1i(u('u_qWinInvert'), w.invert ? 1 : 0);
    }
    gl.uniform3fv(u('u_qGain'), q.gain);
    gl.uniform1f(u('u_qContrast'), q.contrast);
    gl.uniformMatrix3fv(u('u_qMat'), true, q.mat);
    gl.uniform1i(u('u_qShowMatte'), q.showMatte ? 1 : 0);
  }
}
