/**
 * Per-view frame compositor: blends the camera frame with the stabilized
 * person mask under the active effect. WebGL2 is the primary path (mask
 * feathering and background blur run as shader passes); a Canvas2D fallback
 * answers the same contract when WebGL2 context creation fails, at reduced
 * edge quality. One compositor per mounted view — the shared engine canvas
 * sources stay read-only.
 * @module @deepseek-ai/dsh-client-ui-webcam/client/compositor
 */

import type { MaskCanvas } from './mask.js'
import { MASK_SIZE } from './mask.js'
import type { RenderParams } from './params.js'
import { BLUR_FRAG_SRC, COMPOSITE_FRAG_SRC, VERT_SRC } from './shaders.js'

/** Which rendering path this compositor runs on. */
export type CompositorKind = 'webgl2' | 'canvas2d'

/** The per-frame render contract both paths answer. */
export interface Compositor {
  /** The rendering path in use (status display). */
  readonly kind: CompositorKind
  /**
   * Composite one frame onto the canvas. The canvas's `width`/`height` should
   * already match the frame; the call reallocates nothing at frame size.
   * @param frame - the camera frame (video element or image source).
   * @param params - render parameters from {@link renderParams}.
   * @param mask - the stabilized person-alpha canvas, or undefined before the first segmentation.
   */
  render(frame: TexImageSource, params: RenderParams, mask: MaskCanvas | undefined): void
  /** Install (or clear) the custom replace backdrop image. */
  setBackdropImage(image: ImageBitmap | HTMLImageElement | undefined): void
  /** Release every GL resource; the instance is dead after this. */
  dispose(): void
}

/**
 * Create a compositor bound to a canvas, preferring WebGL2.
 * @param canvas - the view's output canvas (frame-sized attributes).
 * @returns the compositor, or undefined when no 2D context is available either.
 */
export function createCompositor(canvas: HTMLCanvasElement): Compositor | undefined {
  const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, preserveDrawingBuffer: false })
  if (gl !== null) {
    try {
      return new GlCompositor(gl, canvas)
    } catch {
      // Shader compile/link failure: degrade to the 2D path instead of a dead canvas.
      gl.getExtension('WEBGL_lose_context')?.loseContext()
    }
  }
  const ctx = canvas.getContext('2d', { alpha: false })
  return ctx === null ? undefined : new Canvas2dCompositor(ctx, canvas)
}

/** One linked program plus its declared uniform locations. */
interface Program<N extends string> {
  readonly program: WebGLProgram
  /** Location per declared name (null when the compiler optimized it out). */
  readonly uniforms: Readonly<Record<N, WebGLUniformLocation | null>>
}

function compileProgram<N extends string>(gl: WebGL2RenderingContext, fragSrc: string, uniformNames: readonly N[]): Program<N> {
  const compile = (type: number, src: string): WebGLShader => {
    const shader = gl.createShader(type)
    if (shader === null) throw new Error('webcam: shader allocation failed')
    gl.shaderSource(shader, src)
    gl.compileShader(shader)
    if (gl.getShaderParameter(shader, gl.COMPILE_STATUS) !== true) {
      const log = gl.getShaderInfoLog(shader)
      gl.deleteShader(shader)
      throw new Error(`webcam: shader compile failed: ${log ?? 'no log'}`)
    }
    return shader
  }
  const program = gl.createProgram()
  if (program === null) throw new Error('webcam: program allocation failed')
  const vert = compile(gl.VERTEX_SHADER, VERT_SRC)
  const frag = compile(gl.FRAGMENT_SHADER, fragSrc)
  gl.attachShader(program, vert)
  gl.attachShader(program, frag)
  gl.linkProgram(program)
  gl.deleteShader(vert)
  gl.deleteShader(frag)
  if (gl.getProgramParameter(program, gl.LINK_STATUS) !== true) {
    const log = gl.getProgramInfoLog(program)
    gl.deleteProgram(program)
    throw new Error(`webcam: program link failed: ${log ?? 'no log'}`)
  }
  const uniforms = {} as Record<N, WebGLUniformLocation | null>
  for (const name of uniformNames) uniforms[name] = gl.getUniformLocation(program, name)
  return { program, uniforms }
}

function makeTexture(gl: WebGL2RenderingContext): WebGLTexture {
  const tex = gl.createTexture()
  if (tex === null) throw new Error('webcam: texture allocation failed')
  gl.bindTexture(gl.TEXTURE_2D, tex)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  return tex
}

/** The WebGL2 path: blur FBO pair + composite pass. */
class GlCompositor implements Compositor {
  readonly kind = 'webgl2' as const

  readonly #gl: WebGL2RenderingContext
  readonly #canvas: HTMLCanvasElement
  readonly #blur: Program<'uTex' | 'uTexel' | 'uDir' | 'uRadius'>
  readonly #composite: Program<
    'uFrame' | 'uMask' | 'uBg' | 'uBackdrop' | 'uTexelMask' | 'uFrameSize' | 'uImageSize'
    | 'uEffect' | 'uRemoveColor' | 'uGradTop' | 'uGradBottom' | 'uFeather' | 'uMirror' | 'uImageMode'
  >
  readonly #frameTex: WebGLTexture
  readonly #maskTex: WebGLTexture
  readonly #bgA: WebGLTexture
  readonly #bgB: WebGLTexture
  readonly #backdropTex: WebGLTexture
  readonly #dummyTex: WebGLTexture
  readonly #fboA: WebGLFramebuffer
  readonly #fboB: WebGLFramebuffer
  #bgW = 0
  #bgH = 0
  #hasBackdrop = false
  #backdropW = 0
  #backdropH = 0

  constructor(gl: WebGL2RenderingContext, canvas: HTMLCanvasElement) {
    this.#gl = gl
    this.#canvas = canvas
    this.#blur = compileProgram(gl, BLUR_FRAG_SRC, ['uTex', 'uTexel', 'uDir', 'uRadius'])
    this.#composite = compileProgram(gl, COMPOSITE_FRAG_SRC, [
      'uFrame', 'uMask', 'uBg', 'uBackdrop', 'uTexelMask', 'uFrameSize', 'uImageSize',
      'uEffect', 'uRemoveColor', 'uGradTop', 'uGradBottom', 'uFeather', 'uMirror', 'uImageMode',
    ])
    this.#frameTex = makeTexture(gl)
    this.#maskTex = makeTexture(gl)
    this.#bgA = makeTexture(gl)
    this.#bgB = makeTexture(gl)
    this.#backdropTex = makeTexture(gl)
    this.#dummyTex = makeTexture(gl)
    gl.bindTexture(gl.TEXTURE_2D, this.#dummyTex)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]))
    const fbo = (): WebGLFramebuffer => {
      const buffer = gl.createFramebuffer()
      if (buffer === null) throw new Error('webcam: framebuffer allocation failed')
      return buffer
    }
    this.#fboA = fbo()
    this.#fboB = fbo()
  }

  setBackdropImage(image: ImageBitmap | HTMLImageElement | undefined): void {
    const gl = this.#gl
    this.#hasBackdrop = image !== undefined
    gl.bindTexture(gl.TEXTURE_2D, this.#backdropTex)
    if (image === undefined) {
      this.#backdropW = 0
      this.#backdropH = 0
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]))
      return
    }
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image)
    this.#backdropW = image.width
    this.#backdropH = image.height
  }

  render(frame: TexImageSource, params: RenderParams, mask: MaskCanvas | undefined): void {
    const gl = this.#gl
    const w = this.#canvas.width
    const h = this.#canvas.height
    if (w === 0 || h === 0) return
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, 0, w, h)
    // Camera frame: browser-top-down upload, sampled through flipped() in the shaders.
    gl.bindTexture(gl.TEXTURE_2D, this.#frameTex)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame as HTMLVideoElement)
    if (params.effect !== 0 && mask !== undefined) {
      gl.bindTexture(gl.TEXTURE_2D, this.#maskTex)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, mask as HTMLCanvasElement)
    }
    if (params.effect === 2) this.#renderBackgroundBlur(w, h, params)

    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, 0, w, h)
    const u = this.#composite.uniforms
    gl.useProgram(this.#composite.program)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.#frameTex)
    gl.uniform1i(u.uFrame, 0)
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, this.#maskTex)
    gl.uniform1i(u.uMask, 1)
    gl.activeTexture(gl.TEXTURE2)
    gl.bindTexture(gl.TEXTURE_2D, params.effect === 2 ? this.#bgB : this.#dummyTex)
    gl.uniform1i(u.uBg, 2)
    gl.activeTexture(gl.TEXTURE3)
    gl.bindTexture(gl.TEXTURE_2D, params.backdropStops === undefined && this.#hasBackdrop ? this.#backdropTex : this.#dummyTex)
    gl.uniform1i(u.uBackdrop, 3)
    gl.uniform2f(u.uTexelMask, 1 / MASK_SIZE, 1 / MASK_SIZE)
    gl.uniform2f(u.uFrameSize, w, h)
    gl.uniform2f(u.uImageSize, this.#backdropW, this.#backdropH)
    gl.uniform1i(u.uEffect, params.effect)
    gl.uniform3f(u.uRemoveColor, params.removeColor[0], params.removeColor[1], params.removeColor[2])
    const top = params.backdropStops?.[0] ?? [0, 0, 0]
    const bottom = params.backdropStops?.[1] ?? [0, 0, 0]
    gl.uniform3f(u.uGradTop, top[0], top[1], top[2])
    gl.uniform3f(u.uGradBottom, bottom[0], bottom[1], bottom[2])
    gl.uniform1f(u.uFeather, params.feather)
    gl.uniform1i(u.uMirror, params.mirror ? 1 : 0)
    gl.uniform1i(u.uImageMode, params.backdropStops === undefined ? 1 : 0)
    gl.bindVertexArray(null)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }

  /** One horizontal blur sweep over `inputTex` into FBO `target`. */
  #blurPass(
    target: WebGLFramebuffer,
    targetTex: WebGLTexture,
    inputTex: WebGLTexture,
    w: number,
    h: number,
    dir: [number, number],
    radius: number,
  ): void {
    const gl = this.#gl
    gl.bindFramebuffer(gl.FRAMEBUFFER, target)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, targetTex, 0)
    gl.viewport(0, 0, w, h)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, inputTex)
    gl.useProgram(this.#blur.program)
    gl.uniform1i(this.#blur.uniforms.uTex, 0)
    gl.uniform2f(this.#blur.uniforms.uTexel, 1 / w, 1 / h)
    gl.uniform2f(this.#blur.uniforms.uDir, dir[0], dir[1])
    gl.uniform1f(this.#blur.uniforms.uRadius, radius)
    gl.bindVertexArray(null)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }

  #renderBackgroundBlur(w: number, h: number, params: RenderParams): void {
    const bw = Math.max(1, Math.floor(w / 4))
    const bh = Math.max(1, Math.floor(h / 4))
    if (bw !== this.#bgW || bh !== this.#bgH) {
      this.#bgW = bw
      this.#bgH = bh
      const gl = this.#gl
      for (const tex of [this.#bgA, this.#bgB]) {
        gl.bindTexture(gl.TEXTURE_2D, tex)
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, bw, bh, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
      }
    }
    this.#blurPass(this.#fboA, this.#bgA, this.#frameTex, bw, bh, [1, 0], params.blurPx)
    this.#blurPass(this.#fboB, this.#bgB, this.#bgA, bw, bh, [0, 1], params.blurPx)
  }

  dispose(): void {
    const gl = this.#gl
    for (const tex of [this.#frameTex, this.#maskTex, this.#bgA, this.#bgB, this.#backdropTex, this.#dummyTex]) gl.deleteTexture(tex)
    gl.deleteFramebuffer(this.#fboA)
    gl.deleteFramebuffer(this.#fboB)
    gl.deleteProgram(this.#blur.program)
    gl.deleteProgram(this.#composite.program)
  }
}

/** The Canvas2D fallback: same contract, filter-based blur and mask cutout. */
class Canvas2dCompositor implements Compositor {
  readonly kind = 'canvas2d' as const

  readonly #ctx: CanvasRenderingContext2D
  readonly #canvas: HTMLCanvasElement
  readonly #scratch: HTMLCanvasElement
  #backdrop: ImageBitmap | HTMLImageElement | undefined

  constructor(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement) {
    this.#ctx = ctx
    this.#canvas = canvas
    this.#scratch = document.createElement('canvas')
  }

  setBackdropImage(image: ImageBitmap | HTMLImageElement | undefined): void {
    this.#backdrop = image
  }

  render(frame: TexImageSource, params: RenderParams, mask: MaskCanvas | undefined): void {
    const ctx = this.#ctx
    const canvas = this.#canvas
    const w = canvas.width
    const h = canvas.height
    if (w === 0 || h === 0) return
    ctx.save()
    if (params.mirror) {
      ctx.translate(w, 0)
      ctx.scale(-1, 1)
    }
    if (params.effect === 0) {
      ctx.drawImage(frame as CanvasImageSource, 0, 0, w, h)
      ctx.restore()
      return
    }
    // Person cutout: the frame masked by the (feathered) mask alpha.
    if (this.#scratch.width !== w || this.#scratch.height !== h) {
      this.#scratch.width = w
      this.#scratch.height = h
    }
    const cut = this.#scratch.getContext('2d')
    if (cut !== null && mask !== undefined) {
      cut.clearRect(0, 0, w, h)
      cut.drawImage(frame as CanvasImageSource, 0, 0, w, h)
      cut.globalCompositeOperation = 'destination-in'
      cut.filter = `blur(${Math.max(1, params.feather * (w / MASK_SIZE))}px)`
      cut.drawImage(mask as CanvasImageSource, 0, 0, w, h)
      cut.filter = 'none'
      cut.globalCompositeOperation = 'source-over'
    }
    if (params.effect === 1) {
      ctx.fillStyle = `rgb(${params.removeColor.map(c => Math.round(c * 255)).join(' ')})`
      ctx.fillRect(0, 0, w, h)
    } else if (params.effect === 2) {
      ctx.filter = `blur(${Math.round(params.blurPx * 4)}px)`
      ctx.drawImage(frame as CanvasImageSource, 0, 0, w, h)
      ctx.filter = 'none'
    } else if (params.backdropStops !== undefined) {
      const [top, bottom] = params.backdropStops
      const grad = ctx.createLinearGradient(0, 0, 0, h)
      grad.addColorStop(0, `rgb(${top.map(c => Math.round(c * 255)).join(' ')})`)
      grad.addColorStop(1, `rgb(${bottom.map(c => Math.round(c * 255)).join(' ')})`)
      ctx.fillStyle = grad
      ctx.fillRect(0, 0, w, h)
    } else if (this.#backdrop !== undefined) {
      const iw = this.#backdrop.width
      const ih = this.#backdrop.height
      const scale = Math.max(w / iw, h / ih)
      const dw = iw * scale
      const dh = ih * scale
      ctx.drawImage(this.#backdrop, (w - dw) / 2, (h - dh) / 2, dw, dh)
    }
    if (cut !== null && mask !== undefined) ctx.drawImage(this.#scratch, 0, 0)
    ctx.restore()
  }

  dispose(): void {
    this.#backdrop = undefined
  }
}
