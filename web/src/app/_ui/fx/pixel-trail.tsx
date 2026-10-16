/*
 * Pixel Trail — React Bits（https://reactbits.dev/animations/pixel-trail）
 * 原始碼：github.com/DavidHDev/react-bits src/ts-default/Animations/PixelTrail/PixelTrail.tsx（2026-10-15 取；
 * 原型 v4 `prototype/src/components/dashboard/pixel-trail.tsx` 照抄的那份）。
 * 正式版改寫了軌跡的算法（共用規格 §3.5 做法 (a)）：原版每幀把軌跡畫在兩張 2D canvas 上再上傳成貼圖，
 * 這裡改成把最多 64 個軌跡點當 uniform 送進 shader，在 GPU 上每格算一次亮度（先畫進 gridSize² 的小貼圖，
 * 再鋪到畫面），CPU 每幀沒有像素工作、不上傳貼圖。格子、斜角、高光、銀→淡金漸層、光暈的著色照原版。
 * 只留現在橫幅用到的設定（方塊、fade、不 gooey、不 sparkle／flow／圖片）。
 *
 * MIT + Commons Clause License Condition v1.0
 * Copyright (c) 2026 David Haz
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
 * documentation files (the "Software"), to deal in the Software without restriction, including without limitation
 * the rights to use, copy, modify, merge, publish, and distribute the Software as part of an application, website,
 * or product, subject to the following conditions: The above copyright notice and this permission notice shall be
 * included in all copies or substantial portions of the Software.
 * Commons Clause Restriction: You may use this Software, including for any commercial purpose, so long as you do
 * not sell, sublicense, or redistribute the components themselves — whether alone, in a bundle, or as a ported version.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.
 */
'use client'

import { useEffect, useRef, useState } from 'react'
import { MAX_POINTS, TrailPoints } from './trail-points'

/** 現在橫幅的參數（共用規格 §3.5）：銀色新像素、變老轉淡金，斜角高光開滿。 */
const SETTINGS = {
  gridSize: 64,
  trailSize: 0.05,
  maxAge: 800,
  interpolate: 2,
  color: '#c9d1dc',
  trailColor: '#bea468',
  gap: 0.16,
  shine: 1,
  glow: 0.15,
} as const

const VERTEX = `#version 300 es
in vec2 a_position;
void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`

/**
 * 第一趟：畫在 gridSize² 的小貼圖上，每格一個像素。R＝這一格的亮度、G＝新鮮度（1 銀、0 淡金）。
 * 原版是每幀把每個點的放射漸層畫到 512² 與 256² 的 2D canvas 再上傳；這裡同樣的算式在 GPU 上每格算一次。
 */
const FIELD = `#version 300 es
precision highp float;
#define MAX_POINTS ${MAX_POINTS}
uniform vec4 u_points[MAX_POINTS];
uniform int u_count;
uniform float u_gridSize;
uniform float u_trailSize;
uniform float u_maxAge;
out vec4 outColor;

// 點的半徑：前 30% 壽命長大、後 70% 縮小，再乘移動強度。
float radiusOf(vec4 p) {
  float rise = u_maxAge * 0.3;
  float k = p.z < rise ? p.z / rise : 1.0 - (p.z - rise) / (u_maxAge * 0.7);
  return u_trailSize * clamp(k, 0.0, 1.0) * p.w;
}

void main() {
  vec2 center = gl_FragCoord.xy / u_gridSize;
  float cell = 0.0;
  float fresh = 0.0;
  for (int i = 0; i < MAX_POINTS; i++) {
    if (i >= u_count) break;
    vec4 p = u_points[i];
    float r = radiusOf(p);
    if (r <= 0.0) continue;
    float d = distance(center, p.xy);
    // 原版的軌跡 canvas：內圈 1/4 半徑是 0.2，往外線性降到 0；多點之間 screen 疊加。
    float a = 0.2 * (1.0 - clamp((d - 0.25 * r) / (0.75 * r), 0.0, 1.0));
    cell = cell + a - cell * a;
    // 原版的年齡 canvas：3/4 半徑內是新鮮度，最外圈降到 0；多點之間取最大。
    float glaze = 1.0 - clamp((d - 0.75 * r) / (0.25 * r), 0.0, 1.0);
    fresh = max(fresh, clamp(1.0 - p.z / u_maxAge, 0.0, 1.0) * glaze);
  }
  outColor = vec4(cell, fresh, 0.0, 1.0);
}
`

/** 第二趟：鋪滿 canvas，每個像素讀自己那一格畫方塊、斜角與高光；光暈與顏色用線性取樣讓邊緣平滑。 */
const FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D u_field;
uniform vec2 u_resolution;
uniform float u_gridSize;
uniform vec3 u_color;
uniform vec3 u_trailColor;
uniform float u_shine;
uniform float u_glow;
uniform float u_gap;
out vec4 outColor;

const vec3 LIGHT = vec3(-0.42, 0.58, 0.7);

vec3 tone(vec3 base, float strength) {
  vec3 body = mix(base * 0.55, base, smoothstep(0.3, 0.75, strength));
  return mix(body, mix(base, vec3(1.0), 0.22), smoothstep(0.85, 1.0, strength) * u_shine);
}

vec3 shade(vec3 base, vec3 n) {
  vec3 l = normalize(LIGHT);
  vec3 h = normalize(l + vec3(0.0, 0.0, 1.0));
  float lit = dot(n, l) - l.z;
  vec3 color = base * (1.0 + lit * 0.9 * u_shine);
  float spec = pow(max(dot(n, h), 0.0), 64.0) * 0.85 + pow(max(dot(n, h), 0.0), 10.0) * 0.08;
  color += spec * u_shine * mix(vec3(1.0), base, 0.15) * step(0.001, 1.0 - n.z);
  return clamp(color, 0.0, 1.0);
}

void main() {
  float maxRes = max(u_resolution.x, u_resolution.y);
  vec2 q = gl_FragCoord.xy - 0.5 * u_resolution + 0.5 * maxRes;
  vec2 uv = q / maxRes;
  float cs = maxRes / u_gridSize;
  int last = int(u_gridSize) - 1;
  float cell = texelFetch(u_field, clamp(ivec2(floor(q / cs)), ivec2(0), ivec2(last)), 0).r;
  vec2 soft = texture(u_field, uv).rg;
  // 大部分像素附近沒有軌跡：第一步就丟掉，不做後面的著色。
  if (cell <= 0.0 && soft.r <= 0.0) discard;

  vec3 base = mix(u_trailColor, u_color, smoothstep(0.05, 0.95, soft.g));
  vec4 pixel = vec4(0.0);
  if (cell > 0.0) {
    float halfSize = 0.5 * (1.0 - u_gap);
    vec2 local = fract(q / cs) - 0.5;
    vec2 edge = abs(local) - halfSize;
    float d = max(edge.x, edge.y);
    vec2 dir = edge.x > edge.y ? vec2(sign(local.x), 0.0) : vec2(0.0, sign(local.y));
    float alpha = clamp(0.5 - d * cs, 0.0, 1.0) * cell;
    if (alpha > 0.0) {
      float bevel = smoothstep(-0.16 * (1.0 - u_gap), 0.0, d);
      vec3 n = normalize(vec3(dir * bevel * 0.9, 1.0));
      pixel = vec4(shade(tone(base, cell), n) * alpha, alpha);
    }
  }
  if (u_glow > 0.0) {
    float amount = smoothstep(0.0, 0.7, soft.r) * u_glow * 0.55 * (1.0 - pixel.a);
    pixel += vec4(mix(u_trailColor, u_color, 0.5) * amount, amount);
  }
  if (pixel.a <= 0.002) discard;
  outColor = pixel;
}
`

/** `#rrggbb` → 0～1 的 RGB（不用 2D canvas 解析顏色）。 */
function hexColor(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

function compile(gl: WebGL2RenderingContext, type: number, source: string) {
  const shader = gl.createShader(type)
  if (!shader) return null
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return shader
  gl.deleteShader(shader)
  return null
}

function link(gl: WebGL2RenderingContext, fragmentSource: string) {
  const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX)
  const fragment = compile(gl, gl.FRAGMENT_SHADER, fragmentSource)
  const program = gl.createProgram()
  if (vertex && fragment && program) {
    gl.attachShader(program, vertex)
    gl.attachShader(program, fragment)
    gl.bindAttribLocation(program, 0, 'a_position')
    gl.linkProgram(program)
  }
  if (vertex) gl.deleteShader(vertex)
  if (fragment) gl.deleteShader(fragment)
  if (program && gl.getProgramParameter(program, gl.LINK_STATUS)) return program
  if (program) gl.deleteProgram(program)
  return null
}

/**
 * 在 `container` 裡放一張 WebGL2 canvas 跑拖尾，回傳停止函式；沒有 WebGL2（或 shader 編不過）回 null、
 * 不留 canvas、不印 log。canvas 每次掛載都新建，所以 StrictMode 重跑 effect 時不會拿到已經 lose 掉的 context。
 * 執行中 context 被瀏覽器收回（GPU 重置等）時停下、拿掉 canvas，呼叫 `onLost`；不嘗試復原。
 */
function start(container: HTMLElement, onLost: () => void): (() => void) | null {
  const canvas = document.createElement('canvas')
  const gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false })
  if (!gl) return null
  const lose = () => gl.getExtension('WEBGL_lose_context')?.loseContext()

  const fieldProgram = link(gl, FIELD)
  const program = link(gl, FRAGMENT)
  // 格子貼圖：只在這裡配置一次（texStorage2D），之後每幀由第一趟直接畫進去，不從 CPU 上傳。
  const grid = SETTINGS.gridSize
  const field = gl.createTexture()
  const framebuffer = gl.createFramebuffer()
  let ready = !!fieldProgram && !!program
  if (ready) {
    gl.bindTexture(gl.TEXTURE_2D, field)
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, grid, grid)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, field, 0)
    ready = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  }
  if (!ready || !fieldProgram || !program) {
    lose()
    return null
  }

  // 不會變的設定只送一次；每幀只送軌跡點與點數。
  gl.useProgram(fieldProgram)
  gl.uniform1f(gl.getUniformLocation(fieldProgram, 'u_gridSize'), grid)
  gl.uniform1f(gl.getUniformLocation(fieldProgram, 'u_trailSize'), SETTINGS.trailSize)
  gl.uniform1f(gl.getUniformLocation(fieldProgram, 'u_maxAge'), SETTINGS.maxAge)
  const uPoints = gl.getUniformLocation(fieldProgram, 'u_points')
  const uCount = gl.getUniformLocation(fieldProgram, 'u_count')

  gl.useProgram(program)
  gl.uniform1i(gl.getUniformLocation(program, 'u_field'), 0)
  gl.uniform1f(gl.getUniformLocation(program, 'u_gridSize'), grid)
  gl.uniform3fv(gl.getUniformLocation(program, 'u_color'), hexColor(SETTINGS.color))
  gl.uniform3fv(gl.getUniformLocation(program, 'u_trailColor'), hexColor(SETTINGS.trailColor))
  gl.uniform1f(gl.getUniformLocation(program, 'u_shine'), SETTINGS.shine)
  gl.uniform1f(gl.getUniformLocation(program, 'u_glow'), SETTINGS.glow)
  gl.uniform1f(gl.getUniformLocation(program, 'u_gap'), SETTINGS.gap)
  const uResolution = gl.getUniformLocation(program, 'u_resolution')

  const vao = gl.createVertexArray()
  const buffer = gl.createBuffer()
  gl.bindVertexArray(vao)
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
  gl.enableVertexAttribArray(0)
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
  gl.activeTexture(gl.TEXTURE0)
  gl.bindTexture(gl.TEXTURE_2D, field)
  gl.clearColor(0, 0, 0, 0)

  container.appendChild(canvas)

  const trail = new TrailPoints(SETTINGS)
  const packed = new Float32Array(MAX_POINTS * 4)
  let alive = true
  let raf = 0
  let last = 0
  let onScreen = true

  const draw = () => {
    const count = trail.pack(packed)
    if (count > 0) {
      // 第一趟：gridSize² 個格子各算一次。
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer)
      gl.viewport(0, 0, grid, grid)
      gl.useProgram(fieldProgram)
      gl.uniform4fv(uPoints, packed, 0, count * 4)
      gl.uniform1i(uCount, count)
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    }
    gl.viewport(0, 0, canvas.width, canvas.height)
    gl.clear(gl.COLOR_BUFFER_BIT)
    if (count === 0) return
    // 第二趟：畫到畫面上，只畫軌跡點外擴一個半徑＋一格的範圍（其他地方一定是空的）。
    const box = trail.bounds(SETTINGS.trailSize + 1 / grid)
    const side = Math.max(canvas.width, canvas.height)
    const x0 = Math.max(0, Math.floor(box.minX * side - (side - canvas.width) / 2))
    const y0 = Math.max(0, Math.floor(box.minY * side - (side - canvas.height) / 2))
    const x1 = Math.min(canvas.width, Math.ceil(box.maxX * side - (side - canvas.width) / 2))
    const y1 = Math.min(canvas.height, Math.ceil(box.maxY * side - (side - canvas.height) / 2))
    if (x1 <= x0 || y1 <= y0) return
    gl.enable(gl.SCISSOR_TEST)
    gl.scissor(x0, y0, x1 - x0, y1 - y0)
    gl.useProgram(program)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    gl.disable(gl.SCISSOR_TEST)
  }

  const running = () => alive && onScreen && document.visibilityState === 'visible'

  const frame = (now: number) => {
    raf = 0
    if (!alive) return
    trail.tick(last ? now - last : 1000 / 60)
    last = now
    draw()
    // 全部過期就停：最後這一幀已經把畫面清乾淨，下次指標移動再叫醒。
    if (!trail.isIdle() && running()) raf = requestAnimationFrame(frame)
    else last = 0
  }

  const wake = () => {
    if (!raf && running() && !trail.isIdle()) raf = requestAnimationFrame(frame)
  }

  const sleep = () => {
    cancelAnimationFrame(raf)
    raf = 0
    last = 0
  }

  const resize = () => {
    const ratio = Math.min(window.devicePixelRatio || 1, 2)
    const width = Math.max(1, Math.floor(container.clientWidth * ratio))
    const height = Math.max(1, Math.floor(container.clientHeight * ratio))
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width
      canvas.height = height
    }
    gl.useProgram(program)
    gl.uniform2f(uResolution, width, height)
    draw()
  }

  // 指標事件聽在橫幅（`container` 鋪滿它、自己 pointer-events: none），滑鼠在頁面其他地方移動不用算。
  const hero = container.parentElement ?? container
  const onMove = (event: PointerEvent) => {
    const rect = container.getBoundingClientRect()
    const x = event.clientX - rect.left
    const y = event.clientY - rect.top
    const side = Math.max(rect.width, rect.height)
    trail.add((x - rect.width / 2) / side + 0.5, (rect.height / 2 - y) / side + 0.5)
    wake()
  }
  const onLeave = () => trail.leave()
  const onVisibility = () => (running() ? wake() : sleep())
  const onContextLost = () => {
    alive = false
    sleep()
    canvas.remove()
    onLost()
  }

  const resizeObserver = new ResizeObserver(resize)
  resizeObserver.observe(container)
  const intersection = new IntersectionObserver((entries) => {
    onScreen = entries.some((entry) => entry.isIntersecting)
    onVisibility()
  })
  intersection.observe(container)
  canvas.addEventListener('webglcontextlost', onContextLost)
  hero.addEventListener('pointermove', onMove, { passive: true })
  hero.addEventListener('pointerleave', onLeave)
  window.addEventListener('blur', onLeave)
  document.addEventListener('visibilitychange', onVisibility)
  resize()

  return () => {
    alive = false
    sleep()
    resizeObserver.disconnect()
    intersection.disconnect()
    canvas.removeEventListener('webglcontextlost', onContextLost)
    hero.removeEventListener('pointermove', onMove)
    hero.removeEventListener('pointerleave', onLeave)
    window.removeEventListener('blur', onLeave)
    document.removeEventListener('visibilitychange', onVisibility)
    gl.deleteBuffer(buffer)
    gl.deleteVertexArray(vao)
    gl.deleteFramebuffer(framebuffer)
    gl.deleteTexture(field)
    gl.deleteProgram(fieldProgram)
    gl.deleteProgram(program)
    lose()
    canvas.remove()
  }
}

/**
 * 由 `hero-trail.tsx` 以 `next/dynamic`（`ssr: false`）載入，只在瀏覽器端畫。
 * `data-state`：`active`＝有 WebGL2 在畫；`unsupported`＝沒有 WebGL2（或中途被收回），安靜退場（沒有 canvas）。
 */
export default function PixelTrail() {
  const ref = useRef<HTMLDivElement>(null)
  const [state, setState] = useState<'active' | 'unsupported'>()

  useEffect(() => {
    const container = ref.current
    if (!container) return
    const stop = start(container, () => setState('unsupported'))
    setState(stop ? 'active' : 'unsupported')
    return stop ?? undefined
  }, [])

  return <div ref={ref} className="hero-trail" aria-hidden="true" data-testid="hero-trail" data-state={state} />
}
