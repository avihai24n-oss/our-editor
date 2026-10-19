/**
 * WebGL2 implementation of the colour pass. One GL context per grader (one for the player, one
 * per export). `grade()` uploads the source picture, renders the shader into its own canvas at
 * the requested size and returns that canvas, which the 2D compositor then draws with the clip's
 * transform. Caches: the 3D LUT textures (by LUT id) and the curves table (by key).
 */
import type { Lut3D } from './cube';
import type { GradeParams } from './params';
import { FRAGMENT_SHADER, VERTEX_SHADER } from './shader';
import type { ColorGrader, GradeRequest } from './grader';

type GLCanvas = HTMLCanvasElement | OffscreenCanvas;

function makeCanvas(): GLCanvas | null {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(1, 1);
  if (typeof document !== 'undefined') return document.createElement('canvas');
  return null;
}

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(s);
    gl.deleteShader(s);
    throw new Error(`Colour shader failed to compile: ${log}`);
  }
  return s;
}

export class GlGrader implements ColorGrader {
  readonly kind = 'webgl2' as const;
  private gl: WebGL2RenderingContext;
  private prog: WebGLProgram;
  private srcTex: WebGLTexture;
  private curveTex: WebGLTexture;
  private curveKey = '';
  private dummy3d: WebGLTexture;
  private luts = new Map<string, { tex: WebGLTexture; lut: Lut3D }>();
  private loc = new Map<string, WebGLUniformLocation | null>();
  private lost = false;

  static create(getLut: (id: string) => Lut3D | undefined): GlGrader | null {
    const canvas = makeCanvas();
    if (!canvas) return null;
    let gl: WebGL2RenderingContext | null = null;
    try {
      gl = canvas.getContext('webgl2', {
        alpha: true,
        premultipliedAlpha: true,
        antialias: false,
        depth: false,
        stencil: false,
        preserveDrawingBuffer: true,
      }) as WebGL2RenderingContext | null;
    } catch {
      gl = null;
    }
    if (!gl) return null;
    try {
      return new GlGrader(canvas, gl, getLut);
    } catch (e) {
      console.warn('WebGL2 colour pass unavailable, using the CPU fallback', e);
      return null;
    }
  }

  private constructor(
    readonly canvas: GLCanvas,
    gl: WebGL2RenderingContext,
    private getLut: (id: string) => Lut3D | undefined,
  ) {
    this.gl = gl;
    const prog = gl.createProgram()!;
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER));
    gl.bindAttribLocation(prog, 0, 'a_pos');
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(`Colour shader failed to link: ${gl.getProgramInfoLog(prog)}`);
    this.prog = prog;
    gl.useProgram(prog);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    this.srcTex = this.tex2d();
    this.curveTex = this.tex2d();
    gl.bindTexture(gl.TEXTURE_2D, this.curveTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    this.dummy3d = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_3D, this.dummy3d);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, 1, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));

    gl.uniform1i(this.u('u_src'), 0);
    gl.uniform1i(this.u('u_lut'), 1);
    gl.uniform1i(this.u('u_curves'), 2);

    const c = canvas as HTMLCanvasElement;
    if (typeof c.addEventListener === 'function') {
      c.addEventListener('webglcontextlost', (e) => {
        e.preventDefault();
        this.lost = true;
      });
    }
  }

  get ok(): boolean {
    return !this.lost && !this.gl.isContextLost();
  }

  private tex2d(): WebGLTexture {
    const gl = this.gl;
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  private u(name: string): WebGLUniformLocation | null {
    if (!this.loc.has(name)) this.loc.set(name, this.gl.getUniformLocation(this.prog, name));
    return this.loc.get(name)!;
  }

  private lutTexture(id: string): { tex: WebGLTexture; lut: Lut3D } | null {
    const lut = this.getLut(id);
    if (!lut) return null;
    const hit = this.luts.get(id);
    if (hit && hit.lut === lut) return hit;
    const gl = this.gl;
    if (hit) gl.deleteTexture(hit.tex);
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_3D, tex);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) gl.texParameteri(gl.TEXTURE_3D, p, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    // RGB16F is filterable in core WebGL2; FLOAT input is converted on upload
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB16F, lut.size, lut.size, lut.size, 0, gl.RGB, gl.FLOAT, lut.data);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    const entry = { tex, lut };
    if (this.luts.size >= 8) {
      const [k, v] = this.luts.entries().next().value as [string, { tex: WebGLTexture }];
      gl.deleteTexture(v.tex);
      this.luts.delete(k);
    }
    this.luts.set(id, entry);
    return entry;
  }

  grade(req: GradeRequest): CanvasImageSource | null {
    if (!this.ok) return null;
    const gl = this.gl;
    const p: GradeParams = req.params;
    const w = Math.max(1, Math.round(req.outWidth));
    const h = Math.max(1, Math.round(req.outHeight));
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== h) this.canvas.height = h;
    gl.viewport(0, 0, w, h);
    gl.useProgram(this.prog);

    // ---- source
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, req.source as TexImageSource);
    } catch (e) {
      console.warn('Colour pass: could not upload the picture', e);
      return null;
    }
    const cr = req.crop;
    gl.uniform4f(this.u('u_srcRect'), cr.x, cr.y, cr.w, cr.h);
    gl.uniform1f(this.u('u_aspect'), req.aspect);

    // ---- LUT
    const lut = p.lut ? this.lutTexture(p.lut.id) : null;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_3D, lut ? lut.tex : this.dummy3d);
    gl.uniform1i(this.u('u_useLut'), lut ? 1 : 0);
    if (lut && p.lut) {
      gl.uniform1f(this.u('u_lutSize'), lut.lut.size);
      gl.uniform3fv(this.u('u_lutMin'), lut.lut.domainMin);
      gl.uniform3fv(this.u('u_lutMax'), lut.lut.domainMax);
      gl.uniform1f(this.u('u_lutIntensity'), p.lut.intensity);
      gl.uniform1i(this.u('u_lutSkin'), p.lut.protectSkin ? 1 : 0);
    }

    // ---- curves
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.curveTex);
    if (p.curves && p.curvesKey !== this.curveKey) {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 256, 1, gl.RGBA, gl.UNSIGNED_BYTE, p.curves);
      this.curveKey = p.curvesKey;
    }
    gl.uniform1i(this.u('u_useCurves'), p.curves ? 1 : 0);

    // ---- scalars
    gl.uniform2f(this.u('u_look'), p.grayscale, p.sepia);
    gl.uniform3f(this.u('u_wb'), p.temp, p.tint, p.exposure);
    gl.uniform2f(this.u('u_bc'), p.brightness, p.contrast);
    gl.uniform4f(this.u('u_tone'), p.shadows, p.highlights, p.whites, p.blacks);
    gl.uniform1f(this.u('u_brilliance'), p.brilliance);
    gl.uniform1i(this.u('u_useHsl'), p.hsl ? 1 : 0);
    if (p.hsl) gl.uniform1fv(this.u('u_hsl[0]') ?? this.u('u_hsl'), p.hsl);
    gl.uniform1f(this.u('u_sat'), p.saturation);
    gl.uniform1i(this.u('u_useWheels'), p.wheels ? 1 : 0);
    if (p.wheels) {
      gl.uniform3fv(this.u('u_lift'), p.wheels.lift);
      gl.uniform3fv(this.u('u_gain'), p.wheels.gain);
      gl.uniform3fv(this.u('u_gamma'), p.wheels.gamma);
      gl.uniform3fv(this.u('u_offset'), p.wheels.offset);
    }
    gl.uniform1f(this.u('u_fade'), p.fade);
    gl.uniform1f(this.u('u_sharpen'), p.sharpen);
    gl.uniform1f(this.u('u_clarity'), p.clarity);
    gl.uniform1f(this.u('u_vignette'), p.vignette);
    gl.uniform1f(this.u('u_grain'), p.grain);
    gl.uniform1ui(this.u('u_seed'), p.seed >>> 0);

    const m = p.mask;
    gl.uniform1i(this.u('u_maskShape'), m ? m.shape : 0);
    if (m) {
      gl.uniform2f(this.u('u_maskC'), m.cx, m.cy);
      gl.uniform2f(this.u('u_maskS'), m.w, m.h);
      gl.uniform1f(this.u('u_maskRot'), m.rot);
      gl.uniform1f(this.u('u_maskFeather'), m.feather);
      gl.uniform1f(this.u('u_maskRound'), m.roundness);
      gl.uniform1i(this.u('u_maskInvert'), m.invert ? 1 : 0);
    }

    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    return this.canvas as CanvasImageSource;
  }

  dispose(): void {
    const gl = this.gl;
    for (const v of this.luts.values()) gl.deleteTexture(v.tex);
    this.luts.clear();
    gl.deleteTexture(this.srcTex);
    gl.deleteTexture(this.curveTex);
    gl.deleteTexture(this.dummy3d);
    gl.deleteProgram(this.prog);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}
