// Docker API 白名單代理（設計方案 §3.13）。
//
// 開發者後台裡唯一掛原始 /var/run/docker.sock 的容器。Dozzle 與 Beszel agent 用
// DOCKER_HOST=tcp://docker-proxy:2375 連進來，只拿得到「看」的權限：
//   1. 端點白名單：只放行下面 ROUTES 的方法＋路徑，其餘一律 403、不轉發。
//   2. inspect 與 /info 的回應用欄位白名單重組：Config.Env、Cmd、Binds、Mounts 這類
//      含秘密或主機路徑的欄位一律不出去；Docker 日後加的新欄位也漏不出去。
//   3. logs、stats、events 串流原樣轉發。容器清單 /containers/json 照規格也原樣轉發
//      （它會帶 Mounts 的主機路徑與啟動指令，但不含 Config.Env；要收緊另開票）。
// 為什麼不用 tecnativa/docker-socket-proxy：它的 ACL 是前綴放行，CONTAINERS=1 會連
// inspect（Config.Env 有主網站的資料庫密碼）、archive、export 一起放行。
//
// 用法：node proxy/docker-proxy.mjs（環境變數 DOCKER_PROXY_SOCKET、DOCKER_PROXY_PORT）
import { Buffer } from 'node:buffer'
import http from 'node:http'
import process from 'node:process'
import { URL, fileURLToPath } from 'node:url'

// 容器 ID 或名稱：Docker 允許的字元，不含 /、%、..（擋路徑穿越與編碼過的斜線）。
const ID = '[A-Za-z0-9][A-Za-z0-9_.-]*'

const ROUTES = [
  { methods: ['GET'], re: /^\/containers\/json$/, kind: 'stream' },
  { methods: ['GET'], re: new RegExp(`^/containers/${ID}/json$`), kind: 'inspect' },
  { methods: ['GET'], re: new RegExp(`^/containers/${ID}/logs$`), kind: 'stream' },
  { methods: ['GET'], re: new RegExp(`^/containers/${ID}/stats$`), kind: 'stream' },
  { methods: ['GET'], re: /^\/events$/, kind: 'stream' },
  { methods: ['GET'], re: /^\/info$/, kind: 'info' },
  { methods: ['GET'], re: /^\/version$/, kind: 'stream' },
  { methods: ['GET', 'HEAD'], re: /^\/_ping$/, kind: 'stream' },
]

const VERSION_PREFIX = /^\/v[0-9]+(\.[0-9]+)?(?=\/)/

/** 回傳 { kind } 或 null（不在白名單）。path 不含 query。 */
export function matchRoute(method, path) {
  const p = path.replace(VERSION_PREFIX, '')
  if (p.includes('..')) return null
  for (const r of ROUTES) {
    if (r.methods.includes(method) && r.re.test(p)) return { kind: r.kind }
  }
  return null
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

function pick(src, keys) {
  const out = {}
  if (!isObj(src)) return out
  for (const k of keys) if (k in src) out[k] = src[k]
  return out
}

function filterPortBindings(pb) {
  const out = {}
  if (!isObj(pb)) return out
  for (const [port, list] of Object.entries(pb)) {
    out[port] = Array.isArray(list) ? list.map((b) => pick(b, ['HostIp', 'HostPort'])) : []
  }
  return out
}

/**
 * inspect 回應只留白名單欄位。Config 與 HostConfig 一定是非 null 物件，HostConfig 一定有
 * PortBindings、RestartPolicy 兩個鍵：Dozzle v11.1.1（client.go:290、:675、:697）會直接解引用。
 */
export function filterInspect(src) {
  const s = isObj(src) ? src : {}
  const out = pick(s, ['Id', 'Name', 'Created', 'Image', 'State'])
  out.Config = pick(s.Config, ['Hostname', 'Image', 'Tty', 'Labels'])
  out.HostConfig = {
    PortBindings: filterPortBindings(s.HostConfig?.PortBindings),
    RestartPolicy: pick(s.HostConfig?.RestartPolicy, ['Name', 'MaximumRetryCount']),
  }
  const networks = {}
  if (isObj(s.NetworkSettings?.Networks)) {
    for (const name of Object.keys(s.NetworkSettings.Networks)) networks[name] = {}
  }
  out.NetworkSettings = { Networks: networks }
  return out
}

const INFO_KEYS = [
  'Containers',
  'ContainersRunning',
  'ContainersPaused',
  'ContainersStopped',
  'NCPU',
  'MemTotal',
  'ServerVersion',
  'OperatingSystem',
]

/** /info 只回容器數、CPU、記憶體、版本、作業系統（不回主機路徑、registry、proxy 設定）。 */
export function filterInfo(src) {
  return pick(src, INFO_KEYS)
}

// 往回傳的標頭：只留這些（不把上游任何其他標頭帶出去）。
const PASS_HEADERS = [
  'content-type',
  'api-version',
  'docker-experimental',
  'ostype',
  'server',
  'builder-version',
  'swarm',
  'cache-control',
  'pragma',
]

function passHeaders(upstreamHeaders) {
  const out = {}
  for (const k of PASS_HEADERS) if (upstreamHeaders[k] !== undefined) out[k] = upstreamHeaders[k]
  return out
}

function deny(res, status = 403, message = 'docker-proxy: 不在白名單') {
  const body = JSON.stringify({ message })
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

function sendJson(res, status, headers, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(status, { ...headers, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

export function createDockerProxy({ socketPath = '/var/run/docker.sock' } = {}) {
  const server = http.createServer((req, res) => {
    let url
    try {
      url = new URL(req.url, 'http://docker')
    } catch {
      return deny(res, 400, 'docker-proxy: 網址格式錯誤')
    }
    // 原始字串與正規化後的路徑都要乾淨：防 %2F、.. 之類被上游另外解讀。
    const rawPath = req.url.split('?')[0]
    if (rawPath !== url.pathname || rawPath.includes('%')) return deny(res)
    const route = matchRoute(req.method, url.pathname)
    if (!route) return deny(res)

    // 只轉發重組過的路徑與 query；不帶客戶端任何標頭與 body。
    const upstreamReq = http.request({
      socketPath,
      method: req.method,
      path: url.pathname + url.search,
      headers: { host: 'docker', 'user-agent': 'fju-status-docker-proxy' },
    })
    upstreamReq.on('response', (up) => {
      const headers = passHeaders(up.headers)
      if (route.kind === 'stream') {
        res.writeHead(up.statusCode ?? 502, headers)
        up.pipe(res)
        res.on('close', () => up.destroy())
        return
      }
      const chunks = []
      up.on('data', (c) => chunks.push(c))
      up.on('error', () => deny(res, 502, 'docker-proxy: 上游中斷'))
      up.on('end', () => {
        let parsed
        try {
          parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        } catch {
          return deny(res, 502, 'docker-proxy: 上游回應不是 JSON')
        }
        const status = up.statusCode ?? 502
        if (status < 200 || status >= 300) {
          return sendJson(res, status, headers, { message: String(parsed?.message ?? '') })
        }
        sendJson(res, status, headers, route.kind === 'inspect' ? filterInspect(parsed) : filterInfo(parsed))
      })
    })
    upstreamReq.on('error', () => {
      if (!res.headersSent) deny(res, 502, 'docker-proxy: 連不到 Docker')
      else res.destroy()
    })
    // 客戶端斷線（例如 Dozzle 關掉 log 頁）就把上游的串流一起關掉。
    res.on('close', () => {
      if (!res.writableFinished) upstreamReq.destroy()
    })
    upstreamReq.end()
  })

  // attach／exec 會用 Upgrade（hijack）把連線變成雙向串流：一律拒絕，不轉發。
  server.on('upgrade', (_req, socket) => {
    socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
  })
  return server
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const socketPath = process.env.DOCKER_PROXY_SOCKET || '/var/run/docker.sock'
  const port = Number(process.env.DOCKER_PROXY_PORT || 2375)
  createDockerProxy({ socketPath }).listen(port, '0.0.0.0', () => {
    process.stdout.write(`docker-proxy 在 :${port} 聽，上游 ${socketPath}\n`)
  })
}
