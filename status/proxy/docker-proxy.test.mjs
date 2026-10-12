// docker-proxy 的安全測試（設計方案 §3.13、AC-S-6 b）。
// 不碰真的 Docker：上游是一個假的 unix-socket 伺服器，記錄收到的每個請求，
// 對 inspect 回一份帶假秘密的 JSON。驗兩件事：不在白名單的請求 403 且上游一個都沒收到；
// 放行的 inspect 與 /info 只剩白名單欄位。
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Buffer } from 'node:buffer'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { setTimeout } from 'node:timers'

import { createDockerProxy, filterInfo, filterInspect, matchRoute } from './docker-proxy.mjs'

const FAKE_INSPECT = {
  Id: 'abc123',
  Name: '/fju-test-app',
  Created: '2026-10-12T00:00:00Z',
  Image: 'sha256:deadbeef',
  Path: '/bin/secret-entry',
  Args: ['--token', 'FAKESECRET'],
  State: { Status: 'running', Running: true, Health: { Status: 'healthy' } },
  Config: {
    Hostname: 'abc123',
    Image: 'ghcr.io/roy4222/fju-web:main',
    Tty: false,
    Labels: { 'com.docker.compose.project': 'fju-test' },
    Env: ['DATABASE_URL=postgres://fake:FAKESECRET@db/fju'],
    Cmd: ['node', 'server.js', '--secret=FAKESECRET'],
  },
  HostConfig: {
    Binds: ['/srv/fju/secrets:/s'],
    PortBindings: {},
    RestartPolicy: { Name: 'always', MaximumRetryCount: 0 },
    Mounts: [{ Source: '/srv/fju/secrets' }],
  },
  Mounts: [{ Type: 'bind', Source: '/srv/fju/secrets', Destination: '/s' }],
  NetworkSettings: {
    Networks: { 'fju-test_default': { IPAddress: '172.18.0.5', Aliases: ['app'] } },
    SandboxKey: '/var/run/docker/netns/xyz',
  },
}

const FAKE_INFO = {
  ID: 'engine-id',
  Name: 'fju-vm',
  Containers: 9,
  ContainersRunning: 8,
  ContainersPaused: 0,
  ContainersStopped: 1,
  NCPU: 4,
  MemTotal: 8000000000,
  ServerVersion: '28.5.0',
  OperatingSystem: 'Ubuntu 24.04.3 LTS',
  DockerRootDir: '/var/lib/docker',
  RegistryConfig: { IndexConfigs: { 'ghcr.io': {} } },
  HttpProxy: 'http://user:FAKESECRET@proxy',
}

let dir
let upstream
let proxy
let base
const received = []

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docker-proxy-'))
  const sock = path.join(dir, 'docker.sock')
  upstream = http.createServer((req, res) => {
    received.push({ method: req.method, url: req.url })
    const p = req.url.replace(/^\/v[0-9.]+/, '').split('?')[0]
    if (/^\/containers\/[^/]+\/json$/.test(p)) {
      if (p.includes('missing')) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ message: 'No such container: missing' }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(FAKE_INSPECT))
    } else if (p === '/info') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(FAKE_INFO))
    } else if (p === '/_ping') {
      res.writeHead(200, { 'api-version': '1.51', 'content-type': 'text/plain' })
      res.end(req.method === 'HEAD' ? undefined : 'OK')
    } else if (/\/logs$/.test(p)) {
      res.writeHead(200, { 'content-type': 'application/vnd.docker.raw-stream' })
      res.write('line 1\n')
      setTimeout(() => res.end('line 2\n'), 20)
    } else {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify([{ Id: 'abc123' }]))
    }
  })
  await new Promise((r) => upstream.listen(sock, r))
  proxy = createDockerProxy({ socketPath: sock })
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${proxy.address().port}`
})

afterAll(async () => {
  await new Promise((r) => proxy.close(r))
  await new Promise((r) => upstream.close(r))
  fs.rmSync(dir, { recursive: true, force: true })
})

beforeEach(() => {
  received.length = 0
})

function call(method, url) {
  return new Promise((resolve, reject) => {
    const req = http.request(base + url, { method }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () =>
        resolve({
          status: res.statusCode,
          text: Buffer.concat(chunks).toString('utf8'),
          headers: { get: (k) => res.headers[k.toLowerCase()] ?? null },
        }),
      )
    })
    req.on('error', reject)
    req.end()
  })
}

describe('放行的讀取端點', () => {
  it('GET /containers/json 200 並轉發', async () => {
    const r = await call('GET', '/containers/json?all=1')
    expect(r.status).toBe(200)
    expect(received).toEqual([{ method: 'GET', url: '/containers/json?all=1' }])
  })

  it('GET /v1.45/containers/x/json 200，只剩白名單欄位，搜不到秘密', async () => {
    const r = await call('GET', '/v1.45/containers/x/json')
    expect(r.status).toBe(200)
    expect(received).toEqual([{ method: 'GET', url: '/v1.45/containers/x/json' }])
    const body = JSON.parse(r.text)
    expect(Object.keys(body).sort()).toEqual(
      ['Config', 'Created', 'HostConfig', 'Id', 'Image', 'Name', 'NetworkSettings', 'State'].sort(),
    )
    expect(body.Config).toBeTypeOf('object')
    expect(body.Config).not.toBeNull()
    expect(Object.keys(body.Config).sort()).toEqual(['Hostname', 'Image', 'Labels', 'Tty'])
    expect(body.Config.Env).toBeUndefined()
    expect(body.Config.Cmd).toBeUndefined()
    expect(body.HostConfig).toBeTypeOf('object')
    expect(body.HostConfig).not.toBeNull()
    expect(Object.keys(body.HostConfig).sort()).toEqual(['PortBindings', 'RestartPolicy'])
    expect(body.HostConfig.RestartPolicy).toEqual({ Name: 'always', MaximumRetryCount: 0 })
    expect(body.Mounts).toBeUndefined()
    expect(body.NetworkSettings).toEqual({ Networks: { 'fju-test_default': {} } })
    expect(r.text).not.toContain('FAKESECRET')
    expect(r.text).not.toContain('/srv/fju/secrets')
    expect(r.headers.get('content-length')).toBe(String(Buffer.byteLength(r.text)))
  })

  it('GET /containers/x/logs 200，串流原樣轉發', async () => {
    const r = await call('GET', '/containers/x/logs?follow=1&stdout=1')
    expect(r.status).toBe(200)
    expect(r.text).toBe('line 1\nline 2\n')
    expect(received).toEqual([{ method: 'GET', url: '/containers/x/logs?follow=1&stdout=1' }])
  })

  it('GET /containers/x/stats、/events、/version 放行', async () => {
    for (const u of ['/containers/x/stats?stream=0&one-shot=1', '/v1.51/events', '/version']) {
      expect((await call('GET', u)).status).toBe(200)
    }
    expect(received.map((r) => r.url)).toEqual(['/containers/x/stats?stream=0&one-shot=1', '/v1.51/events', '/version'])
  })

  it('GET 與 HEAD /_ping 放行，保留 API-Version 標頭（Dozzle 靠它協商版本）', async () => {
    const g = await call('GET', '/_ping')
    expect(g.status).toBe(200)
    expect(g.headers.get('api-version')).toBe('1.51')
    const h = await call('HEAD', '/_ping')
    expect(h.status).toBe(200)
    expect(received.map((r) => r.method)).toEqual(['GET', 'HEAD'])
  })

  it('/info 只剩容器數、CPU、記憶體、版本、作業系統', async () => {
    const r = await call('GET', '/info')
    expect(r.status).toBe(200)
    expect(Object.keys(JSON.parse(r.text)).sort()).toEqual(
      [
        'Containers',
        'ContainersPaused',
        'ContainersRunning',
        'ContainersStopped',
        'MemTotal',
        'NCPU',
        'OperatingSystem',
        'ServerVersion',
      ].sort(),
    )
    expect(r.text).not.toContain('FAKESECRET')
    expect(r.text).not.toContain('/var/lib/docker')
  })

  it('inspect 上游回 404 時只轉回 message，不轉其他欄位', async () => {
    const r = await call('GET', '/containers/missing/json')
    expect(r.status).toBe(404)
    expect(JSON.parse(r.text)).toEqual({ message: 'No such container: missing' })
  })
})

describe('拒絕：403 且上游沒收到任何請求', () => {
  const denied = [
    ['POST', '/containers/x/stop'],
    ['POST', '/containers/x/exec'],
    ['GET', '/containers/x/archive?path=/'],
    ['GET', '/containers/x/export'],
    ['GET', '/images/json'],
    ['DELETE', '/containers/x'],
    ['GET', '/containers/x/top'],
    ['POST', '/containers/x/attach'],
    ['POST', '/containers/create'],
    ['PUT', '/containers/x/archive'],
    ['GET', '/v1.45/containers/x/archive'],
    ['GET', '/containers/../images/json'],
    ['GET', '/containers/%2e%2e/json'],
    ['GET', '/containers/x%2Fjson/logs'],
    ['GET', '/containers/x/json/extra'],
    ['GET', '/v1.45/v1.45/info'],
    ['HEAD', '/containers/json'],
    ['GET', '/exec/abc/json'],
    ['GET', '/secrets'],
  ]
  for (const [method, url] of denied) {
    it(`${method} ${url}`, async () => {
      const r = await call(method, url)
      expect(r.status).toBe(403)
      expect(received).toEqual([])
    })
  }

  it('原始路徑不經正規化直接送（..、%2F、%2e）也一律 403', async () => {
    const port = proxy.address().port
    for (const raw of ['/containers/../images/json', '/containers/x%2Fjson', '/containers/%2e%2e/info', '/v1.45/../info']) {
      const status = await new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path: raw, method: 'GET' }, (res) => {
          res.resume()
          resolve(res.statusCode)
        })
        req.on('error', reject)
        req.end()
      })
      expect(status, raw).toBe(403)
    }
    expect(received).toEqual([])
  })

  it('帶 Upgrade 標頭（attach／exec 的 hijack）一律拒絕，不轉發', async () => {
    const status = await new Promise((resolve, reject) => {
      const req = http.request(base + '/containers/x/logs', {
        method: 'GET',
        headers: { Connection: 'Upgrade', Upgrade: 'tcp' },
      })
      req.on('response', (res) => resolve(res.statusCode))
      req.on('upgrade', () => resolve('upgraded'))
      req.on('error', () => resolve('closed'))
      req.on('timeout', () => reject(new Error('timeout')))
      req.end()
    })
    expect(status === 403 || status === 'closed').toBe(true)
    expect(received).toEqual([])
  })
})

describe('純函式', () => {
  it('matchRoute：只認白名單，去掉 /v1.xx 前綴後比對', () => {
    expect(matchRoute('GET', '/v1.45/containers/abc/json')).toEqual({ kind: 'inspect' })
    expect(matchRoute('GET', '/containers/fju-test-app/logs')).toEqual({ kind: 'stream' })
    expect(matchRoute('GET', '/info')).toEqual({ kind: 'info' })
    expect(matchRoute('POST', '/containers/json')).toBeNull()
    expect(matchRoute('GET', '/containers/abc/archive')).toBeNull()
  })

  it('filterInspect：Config、HostConfig 缺或是 null 時仍給非 null 物件（Dozzle 會直接解引用）', () => {
    const out = filterInspect({ Id: 'a', Config: null, HostConfig: null })
    expect(out.Config).toEqual({})
    expect(out.HostConfig).toEqual({ PortBindings: {}, RestartPolicy: {} })
    expect(filterInspect({}).HostConfig).toEqual({ PortBindings: {}, RestartPolicy: {} })
  })

  it('filterInspect：PortBindings 只留 HostIp、HostPort', () => {
    const out = filterInspect({
      HostConfig: { PortBindings: { '80/tcp': [{ HostIp: '127.0.0.1', HostPort: '8080', Extra: 'x' }] } },
    })
    expect(out.HostConfig.PortBindings).toEqual({ '80/tcp': [{ HostIp: '127.0.0.1', HostPort: '8080' }] })
  })

  it('filterInfo：新欄位也漏不出去', () => {
    expect(filterInfo({ NCPU: 2, Brand: 'new-field', Swarm: { NodeAddr: '10.0.0.1' } })).toEqual({ NCPU: 2 })
  })
})
