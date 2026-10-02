/**
 * GLSL ES 3.00 sources for the WebGL2 compositor. Three programs on one
 * fullscreen-triangle vertex shader: two separable gaussian blur passes for
 * the background, and one composite pass (feathered person alpha, effect
 * selection, backdrop cover-fit). Orientation convention: every sampler reads
 * with `flipY(vUv)` so browser-top-down uploads (video, canvas, image) and
 * same-pipeline FBO results sample consistently; the final pass writes at
 * `vUv`, landing the frame upright on the canvas element.
 * @module @deepseek-ai/dsh-client-ui-webcam/client/shaders
 */

/** Fullscreen triangle: three vertices from gl_VertexID, no buffers. */
export const VERT_SRC = `#version 300 es
out vec2 vUv;
void main() {
  vec2 pos = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = pos;
  gl_Position = vec4(pos * 2.0 - 1.0, 0.0, 1.0);
}
`

/** Separable 9-tap gaussian; uDir picks the axis, uRadius the spread. */
export const BLUR_FRAG_SRC = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
uniform vec2 uTexel;
uniform vec2 uDir;
uniform float uRadius;
out vec4 fragColor;
vec2 flipped(vec2 uv) { return vec2(uv.x, 1.0 - uv.y); }
void main() {
  vec2 uv = flipped(vUv);
  float w0 = 0.227027;
  float w1 = 0.1945946;
  float w2 = 0.1216216;
  float w3 = 0.054054;
  float w4 = 0.016216;
  vec3 acc = texture(uTex, uv).rgb * w0;
  vec2 stepPx = uDir * uTexel * uRadius;
  acc += texture(uTex, uv + stepPx).rgb * w1;
  acc += texture(uTex, uv - stepPx).rgb * w1;
  acc += texture(uTex, uv + stepPx * 2.0).rgb * w2;
  acc += texture(uTex, uv - stepPx * 2.0).rgb * w2;
  acc += texture(uTex, uv + stepPx * 3.0).rgb * w3;
  acc += texture(uTex, uv - stepPx * 3.0).rgb * w3;
  acc += texture(uTex, uv + stepPx * 4.0).rgb * w4;
  acc += texture(uTex, uv - stepPx * 4.0).rgb * w4;
  fragColor = vec4(acc, 1.0);
}
`

/**
 * Composite pass: feathered person alpha from the stabilized mask, effect
 * selection (raw / solid remove / blurred background / gradient or image
 * replace), and cover-fit backdrop sampling. Mirror flips the whole output
 * (frame, mask, and background together), matching self-preview convention.
 */
export const COMPOSITE_FRAG_SRC = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uFrame;
uniform sampler2D uMask;
uniform sampler2D uBg;
uniform sampler2D uBackdrop;
uniform vec2 uTexelMask;
uniform vec2 uFrameSize;
uniform vec2 uImageSize;
uniform int uEffect;
uniform vec3 uRemoveColor;
uniform vec3 uGradTop;
uniform vec3 uGradBottom;
uniform float uFeather;
uniform bool uMirror;
uniform bool uImageMode;
out vec4 fragColor;
vec2 flipped(vec2 uv) { return vec2(uv.x, 1.0 - uv.y); }
vec2 sampleUv() {
  vec2 uv = flipped(vUv);
  return uMirror ? vec2(1.0 - uv.x, uv.y) : uv;
}
float personAlpha(vec2 uv) {
  vec2 stepPx = uTexelMask * uFeather;
  float acc = texture(uMask, uv).r * 0.25;
  acc += texture(uMask, uv + vec2(stepPx.x, 0.0)).r * 0.125;
  acc += texture(uMask, uv - vec2(stepPx.x, 0.0)).r * 0.125;
  acc += texture(uMask, uv + vec2(0.0, stepPx.y)).r * 0.125;
  acc += texture(uMask, uv - vec2(0.0, stepPx.y)).r * 0.125;
  acc += texture(uMask, uv + stepPx).r * 0.0625;
  acc += texture(uMask, uv - stepPx).r * 0.0625;
  acc += texture(uMask, uv + vec2(stepPx.x, -stepPx.y)).r * 0.0625;
  acc += texture(uMask, uv + vec2(-stepPx.x, stepPx.y)).r * 0.0625;
  return acc;
}
vec2 coverUv(vec2 uv) {
  float frameAspect = uFrameSize.x / max(uFrameSize.y, 1.0);
  float imgAspect = uImageSize.x / max(uImageSize.y, 1.0);
  if (imgAspect > frameAspect) {
    float s = frameAspect / imgAspect;
    uv.x = (uv.x - 0.5) * s + 0.5;
  } else {
    float s = imgAspect / frameAspect;
    uv.y = (uv.y - 0.5) * s + 0.5;
  }
  return uv;
}
void main() {
  vec2 uv = sampleUv();
  vec3 fg = texture(uFrame, uv).rgb;
  if (uEffect == 0) {
    fragColor = vec4(fg, 1.0);
    return;
  }
  vec3 bg;
  if (uEffect == 1) {
    bg = uRemoveColor;
  } else if (uEffect == 2) {
    bg = texture(uBg, uv).rgb;
  } else if (uImageMode) {
    bg = texture(uBackdrop, coverUv(uv)).rgb;
  } else {
    bg = mix(uGradTop, uGradBottom, uv.y);
  }
  float alpha = personAlpha(uv);
  fragColor = vec4(mix(bg, fg, alpha), 1.0);
}
`
