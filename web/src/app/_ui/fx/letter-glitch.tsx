'use client'
import { useEffect, useRef } from 'react'
import { startFrameLoop } from './frame-loop'

/**
 * LetterGlitch 引擎（規格④ §4.2，強度「中」）：WebGL2 一張全螢幕三角形，字全在 fragment shader 裡畫。
 * 每格的字由「格子座標＋時間」雜湊出來，不在 CPU 存狀態、每幀不傳資料；三色固定在欄上（第 n 欄用第 n mod 3 色）。
 * 只由 `auth-glitch.tsx` 以 `dynamic(ssr:false)` 載入；這個 chunk 只 import `frame-loop`（不碰共用 UI 模組）。
 * canvas 本身透明，底色 #13305C 在外層 `.auth-glitch`；`data-grid`、`data-fps`、`data-running` 寫在外層給 e2e。
 */
const COLORS: readonly (readonly [number, number, number])[] = [
  [0xe8, 0xb5, 0x44], // 黃
  [0xf0, 0x8f, 0x3a], // 橘
  [0x8d, 0xb6, 0xe6], // 淺藍
]
const GLYPHS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$&*()-_+=/[]{};:<>,'
const ALPHA = 0.28
const HOVER_ALPHA = 0.5
const HOVER_RADIUS = 120
/** 每格每秒換字的次數＝閃爍率 × 速度（0.42 × 0.7）；手機速度減半。 */
const RATE = 0.42 * 0.7

const VERT = `#version 300 es
in vec2 p;
void main() { gl_Position = vec4(p, 0.0, 1.0); }`

const FRAG = `#version 300 es
precision highp float;
uniform sampler2D atlas;
uniform vec2 res;
uniform float cell, t, rate, glyphs, alpha, hoverAlpha, radius;
uniform vec3 mouse;
uniform vec3 c0, c1, c2;
out vec4 o;
float h(vec2 q) { return fract(sin(dot(q, vec2(127.1, 311.7))) * 43758.5453); }
void main() {
  vec2 px = vec2(gl_FragCoord.x, res.y - gl_FragCoord.y);
  vec2 c = floor(px / cell);
  vec2 f = fract(px / cell);
  float k = floor(t * rate + h(c) * 17.0);
  float g = floor(h(c + vec2(mod(k, 97.0) * 0.731, 1.0)) * glyphs);
  float m = texture(atlas, vec2((g + f.x) / glyphs, f.y)).a;
  float col = mod(c.x, 3.0);
  vec3 rgb = col < 0.5 ? c0 : (col < 1.5 ? c1 : c2);
  float a = alpha;
  if (mouse.z > 0.5) a = mix(hoverAlpha, alpha, smoothstep(0.0, radius, distance(px, mouse.xy)));
  o = vec4(rgb * m * a, m * a);
}`

export function LetterGlitch({ onFail }: { onFail: () => void }) {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = ref.current
    const root = canvas?.parentElement
    if (!canvas || !root) return
    const stop = mountLetterGlitch(root, canvas, onFail)
    return stop
  }, [onFail])

  return <canvas ref={ref} />
}

function mountLetterGlitch(root: HTMLElement, canvas: HTMLCanvasElement, onFail: () => void): () => void {
  // preserveDrawingBuffer：e2e 要從 canvas 取樣顏色（AC-23）；整頁只有一張，成本可忽略。
  const gl = canvas.getContext('webgl2', { premultipliedAlpha: true, preserveDrawingBuffer: true, antialias: false })
  if (!gl) {
    onFail()
    return () => {}
  }
  const program = link(gl)
  if (!program) {
    onFail()
    return () => {}
  }
  gl.useProgram(program)
  const buf = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, buf)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
  const loc = gl.getAttribLocation(program, 'p')
  gl.enableVertexAttribArray(loc)
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)
  const u = (name: string) => gl.getUniformLocation(program, name)
  COLORS.forEach((rgb, i) => gl.uniform3f(u(`c${i}`), rgb[0] / 255, rgb[1] / 255, rgb[2] / 255))
  gl.uniform1f(u('glyphs'), GLYPHS.length)
  gl.uniform1f(u('alpha'), ALPHA)
  gl.uniform1f(u('hoverAlpha'), HOVER_ALPHA)
  const tex = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, tex)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)

  const small = window.matchMedia('(max-width: 640px)')
  const fine = window.matchMedia('(pointer: fine)')
  const mouse = { x: 0, y: 0, on: false }
  let dpr = 1
  let cellPx = 0
  let hover = false

  // 尺寸：桌機 14 px 格；≤640 px 18 px、dpr 當 1、速度減半、fps 20、沒有游標亮區（原型修改 3）。
  const layout = () => {
    const mobile = small.matches
    dpr = mobile ? 1 : Math.min(window.devicePixelRatio || 1, 2)
    const grid = mobile ? 18 : 14
    hover = !mobile && fine.matches
    root.dataset.grid = String(grid)
    root.dataset.fps = mobile ? '20' : '30'
    canvas.width = Math.max(1, Math.round(root.clientWidth * dpr))
    canvas.height = Math.max(1, Math.round(root.clientHeight * dpr))
    gl.viewport(0, 0, canvas.width, canvas.height)
    gl.uniform2f(u('res'), canvas.width, canvas.height)
    gl.uniform1f(u('rate'), mobile ? RATE / 2 : RATE)
    gl.uniform1f(u('radius'), HOVER_RADIUS * dpr)
    const next = Math.round(grid * dpr)
    if (next !== cellPx) {
      cellPx = next
      gl.uniform1f(u('cell'), cellPx)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, atlas(cellPx))
    }
    return mobile
  }

  const start = performance.now()
  const draw = () => {
    gl.uniform1f(u('t'), (performance.now() - start) / 1000)
    gl.uniform3f(u('mouse'), mouse.x * dpr, mouse.y * dpr, hover && mouse.on ? 1 : 0)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }

  let loop = startLoop(layout())
  function startLoop(mobile: boolean) {
    return startFrameLoop(root, draw, {
      fps: mobile ? 20 : 30,
      onRunningChange: (running) => (root.dataset.running = running ? '1' : '0'),
    })
  }

  const onResize = () => {
    const wasMobile = root.dataset.fps === '20'
    const mobile = layout()
    if (mobile !== wasMobile) {
      loop.stop()
      loop = startLoop(mobile)
    }
    draw()
  }
  const onMove = (e: PointerEvent) => {
    mouse.x = e.clientX
    mouse.y = e.clientY
    mouse.on = true
  }
  const onLeave = () => (mouse.on = false)
  const onLost = (e: Event) => {
    e.preventDefault()
    cleanup()
    onFail()
  }
  window.addEventListener('resize', onResize)
  window.addEventListener('pointermove', onMove, { passive: true })
  document.documentElement.addEventListener('pointerleave', onLeave)
  canvas.addEventListener('webglcontextlost', onLost)
  draw()

  function cleanup() {
    loop.stop()
    window.removeEventListener('resize', onResize)
    window.removeEventListener('pointermove', onMove)
    document.documentElement.removeEventListener('pointerleave', onLeave)
    canvas.removeEventListener('webglcontextlost', onLost)
  }
  return cleanup
}

/** 字表圖：一列 `GLYPHS`，每字一格、白字透明底（shader 只取 alpha）。 */
function atlas(cell: number): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = cell * GLYPHS.length
  c.height = cell
  const ctx = c.getContext('2d')
  if (!ctx) return c
  ctx.fillStyle = '#fff'
  ctx.font = `${Math.round(cell * 0.78)}px monospace`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  for (let i = 0; i < GLYPHS.length; i += 1) ctx.fillText(GLYPHS[i]!, i * cell + cell / 2, cell / 2)
  return c
}

function link(gl: WebGL2RenderingContext): WebGLProgram | null {
  const program = gl.createProgram()
  for (const [type, src] of [
    [gl.VERTEX_SHADER, VERT],
    [gl.FRAGMENT_SHADER, FRAG],
  ] as const) {
    const s = gl.createShader(type)
    if (!s) return null
    gl.shaderSource(s, src)
    gl.compileShader(s)
    gl.attachShader(program, s)
  }
  gl.linkProgram(program)
  return gl.getProgramParameter(program, gl.LINK_STATUS) ? program : null
}
