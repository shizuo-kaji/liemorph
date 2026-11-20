/**
 * WebGL renderer for a texture-mapped triangle mesh (works with WebGL 1 and 2).
 * World coordinates are image pixels; the view maps world → CSS pixels by
 * screen = world·zoom + pan.
 */
export interface View {
  zoom: number;
  panX: number;
  panY: number;
}

const VS = `
attribute vec2 aPos;
attribute vec2 aUv;
attribute vec4 aCol;
uniform vec3 uView;
uniform vec2 uSize;
varying vec2 vUv;
varying vec4 vCol;
void main() {
  vec2 s = aPos * uView.x + uView.yz;
  gl_Position = vec4(s.x / uSize.x * 2.0 - 1.0, 1.0 - s.y / uSize.y * 2.0, 0.0, 1.0);
  vUv = aUv;
  vCol = aCol;
}`;

const FS = `
precision mediump float;
uniform sampler2D uTex;
uniform float uAlpha;
uniform float uMode; // 0 texture, 1 vertex colour, 2 flat colour
uniform vec4 uFlat;
varying vec2 vUv;
varying vec4 vCol;
void main() {
  vec4 c;
  if (uMode < 0.5) c = texture2D(uTex, vUv);
  else if (uMode < 1.5) c = vec4(vCol.rgb * vCol.a, vCol.a);
  else c = vec4(uFlat.rgb * uFlat.a, uFlat.a);
  gl_FragColor = c * uAlpha;
}`;

export class GLRenderer {
  readonly canvas: HTMLCanvasElement;
  readonly gl: WebGLRenderingContext;
  readonly isGL2: boolean;
  private prog: WebGLProgram;
  private loc: { pos: number; uv: number; col: number; view: WebGLUniformLocation; size: WebGLUniformLocation; alpha: WebGLUniformLocation; mode: WebGLUniformLocation; flat: WebGLUniformLocation };
  private posBuf: WebGLBuffer;
  private uvBuf: WebGLBuffer;
  private idxBuf: WebGLBuffer;
  private quadPos: WebGLBuffer;
  private quadUv: WebGLBuffer;
  private heatPos: WebGLBuffer;
  private heatCol: WebGLBuffer;
  private tex: WebGLTexture | null = null;
  private nIdx = 0;
  private nVerts = 0;
  private pos32 = new Float32Array(0);
  private heatN = 0;
  imgW = 1;
  imgH = 1;
  private uint32: boolean;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const attrs: WebGLContextAttributes = { alpha: true, antialias: true, premultipliedAlpha: true, preserveDrawingBuffer: false };
    const gl2 = canvas.getContext('webgl2', attrs) as WebGL2RenderingContext | null;
    const gl = gl2 ?? (canvas.getContext('webgl', attrs) as WebGLRenderingContext | null);
    if (!gl) throw new Error('WebGL is not available');
    this.gl = gl;
    this.isGL2 = !!gl2;
    this.uint32 = this.isGL2 || !!gl.getExtension('OES_element_index_uint');
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader');
      return s;
    };
    const p = gl.createProgram()!;
    gl.attachShader(p, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? 'link');
    this.prog = p;
    this.loc = {
      pos: gl.getAttribLocation(p, 'aPos'),
      uv: gl.getAttribLocation(p, 'aUv'),
      col: gl.getAttribLocation(p, 'aCol'),
      view: gl.getUniformLocation(p, 'uView')!,
      size: gl.getUniformLocation(p, 'uSize')!,
      alpha: gl.getUniformLocation(p, 'uAlpha')!,
      mode: gl.getUniformLocation(p, 'uMode')!,
      flat: gl.getUniformLocation(p, 'uFlat')!,
    };
    this.posBuf = gl.createBuffer()!;
    this.uvBuf = gl.createBuffer()!;
    this.idxBuf = gl.createBuffer()!;
    this.quadPos = gl.createBuffer()!;
    this.quadUv = gl.createBuffer()!;
    this.heatPos = gl.createBuffer()!;
    this.heatCol = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadUv);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1]), gl.STATIC_DRAW);
  }

  get maxTexture(): number {
    return this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE) as number;
  }

  setImage(src: TexImageSource, w: number, h: number) {
    const gl = this.gl;
    this.imgW = w;
    this.imgH = h;
    if (this.tex) gl.deleteTexture(this.tex);
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    const pot = (v: number) => (v & (v - 1)) === 0;
    const sw = (src as { width: number }).width, shh = (src as { height: number }).height;
    if (this.isGL2 || (pot(sw) && pot(shh))) {
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    } else {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    }
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.tex = tex;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadPos);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, w, 0, w, h, 0, 0, w, h, 0, h]), gl.STATIC_DRAW);
  }

  /** Upload topology and texture coordinates (from rest positions). */
  setMesh(rest: Float64Array, tris: Uint32Array) {
    const gl = this.gl;
    const n = rest.length >> 1;
    this.nVerts = n;
    const uv = new Float32Array(2 * n);
    for (let i = 0; i < n; i++) {
      uv[2 * i] = rest[2 * i] / this.imgW;
      uv[2 * i + 1] = rest[2 * i + 1] / this.imgH;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.uvBuf);
    gl.bufferData(gl.ARRAY_BUFFER, uv, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.idxBuf);
    if (this.uint32 || n > 65535) gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, Uint32Array.from(tris), gl.STATIC_DRAW);
    else gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, Uint16Array.from(tris), gl.STATIC_DRAW);
    this.nIdx = tris.length;
    this.pos32 = new Float32Array(2 * n);
    this.updatePositions(rest);
  }

  clearMesh() {
    this.nIdx = 0;
    this.nVerts = 0;
  }

  updatePositions(pos: ArrayLike<number>) {
    const gl = this.gl;
    if (this.pos32.length !== pos.length) this.pos32 = new Float32Array(pos.length);
    for (let i = 0; i < pos.length; i++) this.pos32[i] = pos[i];
    gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.pos32, gl.DYNAMIC_DRAW);
  }

  /** Per-triangle colours (expanded, non-indexed) for heatmaps. colors: rgba 0..1 per triangle. */
  setHeat(pos: ArrayLike<number>, tris: Uint32Array, colors: Float32Array) {
    const gl = this.gl;
    const m = tris.length / 3;
    const P = new Float32Array(6 * m), C = new Float32Array(12 * m);
    for (let t = 0; t < m; t++) {
      for (let k = 0; k < 3; k++) {
        const v = tris[3 * t + k];
        P[6 * t + 2 * k] = pos[2 * v];
        P[6 * t + 2 * k + 1] = pos[2 * v + 1];
        C.set(colors.subarray(4 * t, 4 * t + 4), 12 * t + 4 * k);
      }
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.heatPos);
    gl.bufferData(gl.ARRAY_BUFFER, P, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.heatCol);
    gl.bufferData(gl.ARRAY_BUFFER, C, gl.DYNAMIC_DRAW);
    this.heatN = 3 * m;
  }

  resize(cssW: number, cssH: number, dpr: number) {
    const w = Math.max(1, Math.round(cssW * dpr)), hh = Math.max(1, Math.round(cssH * dpr));
    if (this.canvas.width !== w || this.canvas.height !== hh) {
      this.canvas.width = w;
      this.canvas.height = hh;
    }
  }

  draw(
    view: View,
    cssW: number,
    cssH: number,
    o: { image: boolean; imageAlpha: number; mesh: boolean; texture: boolean; heat: boolean; heatAlpha: number; clear: [number, number, number, number]; flat: [number, number, number, number] },
  ) {
    const gl = this.gl;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(o.clear[0] * o.clear[3], o.clear[1] * o.clear[3], o.clear[2] * o.clear[3], o.clear[3]);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(this.prog);
    gl.uniform3f(this.loc.view, view.zoom, view.panX, view.panY);
    gl.uniform2f(this.loc.size, cssW, cssH);
    gl.uniform4f(this.loc.flat, o.flat[0], o.flat[1], o.flat[2], o.flat[3]);
    if (this.tex) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
    }
    const L = this.loc;
    gl.disableVertexAttribArray(L.col);
    gl.vertexAttrib4f(L.col, 0, 0, 0, 0);
    const bindAttr = (loc: number, buf: WebGLBuffer, size: number) => {
      if (loc < 0) return;
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
    };
    if (o.image && this.tex) {
      bindAttr(L.pos, this.quadPos, 2);
      bindAttr(L.uv, this.quadUv, 2);
      gl.uniform1f(L.mode, 0);
      gl.uniform1f(L.alpha, o.imageAlpha);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }
    if (o.mesh && this.nIdx) {
      bindAttr(L.pos, this.posBuf, 2);
      bindAttr(L.uv, this.uvBuf, 2);
      gl.uniform1f(L.mode, o.texture && this.tex ? 0 : 2);
      gl.uniform1f(L.alpha, 1);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.idxBuf);
      const type = this.uint32 || this.nVerts > 65535 ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;
      gl.drawElements(gl.TRIANGLES, this.nIdx, type, 0);
    }
    if (o.heat && this.heatN) {
      bindAttr(L.pos, this.heatPos, 2);
      if (L.uv >= 0) gl.disableVertexAttribArray(L.uv);
      bindAttr(L.col, this.heatCol, 4);
      gl.uniform1f(L.mode, 1);
      gl.uniform1f(L.alpha, o.heatAlpha);
      gl.drawArrays(gl.TRIANGLES, 0, this.heatN);
      gl.disableVertexAttribArray(L.col);
    }
  }
}
