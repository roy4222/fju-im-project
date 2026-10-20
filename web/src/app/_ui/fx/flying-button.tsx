import './flying-button.css'
import { startFrameLoop } from './frame-loop'

/**
 * 彩蛋第 10 下的 Flying Button（規格④ 設計方案 §10）：logo 的分身噴火起飛、再落回原位。
 * 由 `easter-egg.tsx` 在第 3 下 `import()` 預載，不進任何路由的首次載入；開了減少動態的人不下載。
 * 容器 `position: fixed` 疊在視窗上方 460 px（不擋點擊）；噴焰是 WebGL2 片段著色器，迴圈走共用的 `frame-loop`。
 * WebGL2 不支援時回 null，呼叫端只顯示訊息。
 */

const VERT = `#version 300 es
in vec2 p;
out vec2 uv;
void main() { uv = p * 0.5 + 0.5; gl_Position = vec4(p, 0.0, 1.0); }`

// 噴焰：往下拉長的淚滴形，用兩層值雜訊抖動邊緣；顏色由白黃 → 橘 → 透明。
const FRAG = `#version 300 es
precision mediump float;
in vec2 uv;
uniform float t;
out vec4 o;
float h(vec2 q) { return fract(sin(dot(q, vec2(127.1, 311.7))) * 43758.5453); }
float n(vec2 q) {
  vec2 i = floor(q), f = fract(q);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h(i), h(i + vec2(1, 0)), f.x), mix(h(i + vec2(0, 1)), h(i + vec2(1, 1)), f.x), f.y);
}
void main() {
  float y = 1.0 - uv.y;
  float x = (uv.x - 0.5) * 2.0;
  float flick = n(vec2(x * 3.0, y * 6.0 - t * 9.0)) * 0.6 + n(vec2(x * 7.0, y * 12.0 - t * 15.0)) * 0.4;
  float width = (1.0 - y) * 0.55 + 0.08;
  float body = smoothstep(width, width * 0.4, abs(x) + flick * 0.25 * y);
  float fade = smoothstep(1.0, 0.25, y + flick * 0.2);
  float a = body * fade;
  vec3 c = mix(vec3(0.898, 0.431, 0.0), vec3(1.0, 0.93, 0.6), smoothstep(0.35, 0.9, a));
  o = vec4(c * a, a);
}`

function startFlame(canvas: HTMLCanvasElement): (() => void) | null {
  const gl = canvas.getContext('webgl2', { premultipliedAlpha: true, alpha: true })
  if (!gl) return null
  const shader = (type: number, src: string) => {
    const s = gl.createShader(type)!
    gl.shaderSource(s, src)
    gl.compileShader(s)
    return s
  }
  const prog = gl.createProgram()!
  gl.attachShader(prog, shader(gl.VERTEX_SHADER, VERT))
  gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, FRAG))
  gl.linkProgram(prog)
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null
  gl.useProgram(prog)
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer())
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
  const loc = gl.getAttribLocation(prog, 'p')
  gl.enableVertexAttribArray(loc)
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)
  const tLoc = gl.getUniformLocation(prog, 't')
  gl.viewport(0, 0, canvas.width, canvas.height)
  const loop = startFrameLoop(
    canvas,
    (_dt, now) => {
      gl.clear(gl.COLOR_BUFFER_BIT)
      gl.uniform1f(tLoc, now / 1000)
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    },
    { fps: 60 },
  )
  return () => {
    loop.stop()
    gl.getExtension('WEBGL_lose_context')?.loseContext()
  }
}

/**
 * 從 `logo` 目前的位置起飛；飛完（或 30 秒安全上限）自己清掉並呼叫 `onDone`。
 * 回傳提前清掉的函式；WebGL2 不支援時什麼都不掛、回 null。
 */
export function launchFlyingButton(logo: HTMLImageElement, onDone: () => void): (() => void) | null {
  const rect = logo.getBoundingClientRect()
  const stage = document.createElement('div')
  stage.className = 'flying-button'
  stage.dataset.fx = 'flying-button'
  stage.setAttribute('aria-hidden', 'true')
  const rocket = document.createElement('div')
  rocket.className = 'flying-button-rocket'
  rocket.style.setProperty('--fb-x', `${rect.left}px`)
  rocket.style.setProperty('--fb-y', `${rect.top}px`)
  rocket.style.setProperty('--fb-w', `${rect.width}px`)
  const img = logo.cloneNode() as HTMLImageElement
  img.removeAttribute('class')
  img.alt = ''
  const canvas = document.createElement('canvas')
  canvas.width = 96
  canvas.height = 160
  rocket.append(img, canvas)
  stage.append(rocket)
  document.body.append(stage)

  const stopFlame = startFlame(canvas)
  if (!stopFlame) {
    stage.remove()
    return null
  }
  let done = false
  const cleanup = () => {
    if (done) return
    done = true
    window.clearTimeout(cap)
    stopFlame()
    stage.remove()
    onDone()
  }
  const cap = window.setTimeout(cleanup, 30_000)
  rocket.addEventListener('animationend', cleanup, { once: true })
  return cleanup
}
