// A thin WebGL2 layer: compiling shaders (every pass is a full-frame quad), render targets from a
// pool, and texture uploads. Pictures are kept with premultiplied alpha in half-float targets when
// the GPU allows (smoother color grading), and textures are uploaded upright (origin bottom-left).

export interface Target {
  fb: WebGLFramebuffer;
  tex: WebGLTexture;
  w: number;
  h: number;
}

type UniformValue = number | boolean | number[] | Float32Array;

interface Prog {
  program: WebGLProgram;
  uniforms: Map<string, { loc: WebGLUniformLocation; type: number; size: number }>;
}

const VERTEX = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

export class Gl {
  readonly gl: WebGL2RenderingContext;
  private programs = new Map<string, Prog>();
  private pool: Target[] = [];
  private vao: WebGLVertexArrayObject;
  private float: boolean;
  private lost = false;

  constructor(readonly canvas: HTMLCanvasElement | OffscreenCanvas) {
    const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: true, preserveDrawingBuffer: true, powerPreference: 'high-performance' }) as WebGL2RenderingContext | null;
    if (!gl) throw new Error('This computer’s graphics don’t support WebGL 2, which Frameline needs to show video.');
    this.gl = gl;
    this.float = !!gl.getExtension('EXT_color_buffer_float');
    gl.getExtension('OES_texture_float_linear');
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    if ('addEventListener' in canvas) {
      canvas.addEventListener('webglcontextlost', (e) => {
        e.preventDefault();
        this.lost = true;
      });
    }
  }

  get isLost(): boolean {
    return this.lost || this.gl.isContextLost();
  }

  program(fragment: string): Prog {
    let p = this.programs.get(fragment);
    if (p) return p;
    const gl = this.gl;
    const compile = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`Shader error: ${gl.getShaderInfoLog(s)}\n${src.split('\n').slice(0, 6).join('\n')}`);
      return s;
    };
    const program = gl.createProgram()!;
    gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragment));
    gl.bindAttribLocation(program, 0, 'aPos');
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`Shader link error: ${gl.getProgramInfoLog(program)}`);
    const uniforms = new Map<string, { loc: WebGLUniformLocation; type: number; size: number }>();
    const n = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS) as number;
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(program, i)!;
      const name = info.name.replace(/\[0\]$/, '');
      uniforms.set(name, { loc: gl.getUniformLocation(program, info.name)!, type: info.type, size: info.size });
    }
    p = { program, uniforms };
    this.programs.set(fragment, p);
    return p;
  }

  /** A render target of this size (transparent), from the pool. */
  target(w: number, h: number): Target {
    w = Math.max(1, Math.round(w));
    h = Math.max(1, Math.round(h));
    const i = this.pool.findIndex((t) => t.w === w && t.h === h);
    const t = i >= 0 ? this.pool.splice(i, 1)[0] : this.makeTarget(w, h);
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb);
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    return t;
  }

  release(t: Target | null | undefined): void {
    if (!t) return;
    this.pool.push(t);
    // Don't hoard memory: a few spare targets of each size are plenty
    if (this.pool.length > 24) {
      const old = this.pool.shift()!;
      this.gl.deleteFramebuffer(old.fb);
      this.gl.deleteTexture(old.tex);
    }
  }

  private makeTarget(w: number, h: number): Target {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    if (this.float) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    this.texParams(gl.TEXTURE_2D);
    const fb = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    return { fb, tex, w, h };
  }

  private texParams(kind: number, filter: number = this.gl.LINEAR): void {
    const gl = this.gl;
    gl.texParameteri(kind, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(kind, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(kind, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(kind, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (kind === gl.TEXTURE_3D) gl.texParameteri(kind, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
  }

  /** Uploads a picture (video, image, canvas, VideoFrame) into a texture (made when not given). */
  upload(source: TexImageSource, tex?: WebGLTexture | null): WebGLTexture {
    const gl = this.gl;
    const t = tex ?? gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    if (!tex) this.texParams(gl.TEXTURE_2D);
    return t;
  }

  /** A 3D color lookup texture (a LUT's size³ RGB values, red fastest). */
  lut3d(data: Float32Array, size: number): WebGLTexture {
    const gl = this.gl;
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_3D, t);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB16F, size, size, size, 0, gl.RGB, gl.FLOAT, data);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    this.texParams(gl.TEXTURE_3D);
    return t;
  }

  deleteTexture(t: WebGLTexture | null | undefined): void {
    if (t) this.gl.deleteTexture(t);
  }

  /**
   * Runs a shader over a whole target (or the canvas when `out` is null). Textures are given as
   * uniforms: a WebGLTexture for sampler2D, or { tex3d } for sampler3D.
   */
  pass(fragment: string, out: Target | null, uniforms: Record<string, UniformValue | WebGLTexture | { tex3d: WebGLTexture } | null | undefined>, size?: [number, number]): void {
    const gl = this.gl;
    const p = this.program(fragment);
    gl.useProgram(p.program);
    gl.bindVertexArray(this.vao);
    gl.bindFramebuffer(gl.FRAMEBUFFER, out ? out.fb : null);
    const w = out ? out.w : size?.[0] ?? gl.drawingBufferWidth;
    const h = out ? out.h : size?.[1] ?? gl.drawingBufferHeight;
    gl.viewport(0, 0, w, h);
    let unit = 0;
    for (const [name, u] of p.uniforms) {
      let v = uniforms[name];
      if (v === undefined && name === 'uSize') v = [w, h];
      if (v === undefined || v === null) {
        if (u.type === gl.SAMPLER_2D || u.type === gl.SAMPLER_3D) {
          // Unset samplers read an empty texture
          gl.activeTexture(gl.TEXTURE0 + unit);
          gl.bindTexture(u.type === gl.SAMPLER_3D ? gl.TEXTURE_3D : gl.TEXTURE_2D, null);
          gl.uniform1i(u.loc, unit++);
        }
        continue;
      }
      switch (u.type) {
        case gl.SAMPLER_2D:
          gl.activeTexture(gl.TEXTURE0 + unit);
          gl.bindTexture(gl.TEXTURE_2D, v as WebGLTexture);
          gl.uniform1i(u.loc, unit++);
          break;
        case gl.SAMPLER_3D:
          gl.activeTexture(gl.TEXTURE0 + unit);
          gl.bindTexture(gl.TEXTURE_3D, (v as { tex3d: WebGLTexture }).tex3d);
          gl.uniform1i(u.loc, unit++);
          break;
        case gl.FLOAT:
          if (u.size > 1) gl.uniform1fv(u.loc, v as number[]);
          else gl.uniform1f(u.loc, Number(v));
          break;
        case gl.INT:
        case gl.BOOL:
          gl.uniform1i(u.loc, typeof v === 'boolean' ? (v ? 1 : 0) : Math.round(Number(v)));
          break;
        case gl.FLOAT_VEC2:
          gl.uniform2fv(u.loc, v as number[]);
          break;
        case gl.FLOAT_VEC3:
          gl.uniform3fv(u.loc, v as number[]);
          break;
        case gl.FLOAT_VEC4:
          gl.uniform4fv(u.loc, v as number[]);
          break;
        case gl.FLOAT_MAT3:
          gl.uniformMatrix3fv(u.loc, false, v as number[]);
          break;
      }
    }
    gl.disable(gl.BLEND);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /** Clears a target (or the canvas) to a color. */
  clear(out: Target | null, rgba: [number, number, number, number]): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, out ? out.fb : null);
    if (out) gl.viewport(0, 0, out.w, out.h);
    else gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.clearColor(...rgba);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  /** Reads a target's pixels (RGBA bytes, bottom row first) — for scopes and auto color. */
  read(t: Target): Uint8Array {
    const gl = this.gl;
    const tmp = this.makeByteTarget(t.w, t.h);
    this.pass(COPY, tmp, { uTex: t.tex });
    const out = new Uint8Array(t.w * t.h * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, tmp.fb);
    gl.readPixels(0, 0, t.w, t.h, gl.RGBA, gl.UNSIGNED_BYTE, out);
    gl.deleteFramebuffer(tmp.fb);
    gl.deleteTexture(tmp.tex);
    return out;
  }

  private makeByteTarget(w: number, h: number): Target {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    this.texParams(gl.TEXTURE_2D, gl.NEAREST);
    const fb = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    return { fb, tex, w, h };
  }

  dispose(): void {
    const gl = this.gl;
    for (const t of this.pool) {
      gl.deleteFramebuffer(t.fb);
      gl.deleteTexture(t.tex);
    }
    this.pool = [];
    for (const p of this.programs.values()) gl.deleteProgram(p.program);
    this.programs.clear();
  }
}

export const COPY = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
out vec4 o;
void main() { o = texture(uTex, vUv); }`;
