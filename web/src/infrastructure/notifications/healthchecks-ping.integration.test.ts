/** ⑤-06（AC-40、AC-41）：真 worker＋本機假 Healthchecks.io 伺服器。持鎖的 worker 打卡、拿不到鎖的備援不打；沒設網址不 fetch。 */
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Pool } from "pg";
import {
  assertTestDatabaseReachable,
  createIsolatedDatabase,
  poolAsRole,
  TEST_DATABASE_URL,
  type IsolatedDatabase,
} from "../../../test/db";
import { migratedSchema } from "../../../test/migrations";

let owner: IsolatedDatabase;
let app: Pool;
let server: http.Server;
let hits: string[] = [];
let base = "";
let m: {
  worker: typeof import("@/composition/worker");
  db: typeof import("@/infrastructure/db/client");
};
const logs: string[] = [];
const log = (message: string, detail?: Record<string, unknown>) =>
  logs.push(`${message} ${JSON.stringify(detail ?? {})}`);

beforeAll(async () => {
  await assertTestDatabaseReachable();
  owner = await createIsolatedDatabase({ label: "hc", setup: migratedSchema });
  app = await poolAsRole(owner, "fju_app");
  server = http.createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    res.end("OK");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const url = new URL(TEST_DATABASE_URL);
  url.username = "fju_app";
  url.password = process.env.TEST_FJU_APP_PASSWORD ?? "fju_app_local_test";
  url.searchParams.set("options", `-c search_path=${owner.schemaName}`);
  vi.resetModules();
  vi.stubEnv("DATABASE_URL", url.toString());
  m = {
    worker: await import("@/composition/worker"),
    db: await import("@/infrastructure/db/client"),
  };
});

afterAll(async () => {
  await m?.db.getPool().end();
  await app?.end();
  await owner?.close();
  server?.close();
  vi.unstubAllEnvs();
});

const opts = (lockName: string, url?: string) => ({
  version: "v1",
  lockName,
  projectionIntervalMs: 60_000,
  dueWorkIntervalMs: 60_000,
  reconcileIntervalMs: 60_000,
  healthchecksUrl: url,
  healthchecksIntervalMs: 100,
  log,
});

it("AC-40：持鎖的 worker 每輪打卡；拿不到鎖的備援不打", async () => {
  const lockName = `hc-${owner.schemaName}`;
  const first = await m.worker.startWorker(opts(lockName, `${base}/ping/fake`));
  expect(first).not.toBeNull();
  await vi.waitFor(() => expect(hits.length).toBeGreaterThanOrEqual(3), {
    timeout: 5_000,
  });
  const second = await m.worker.startWorker(
    opts(lockName, `${base}/ping/second`),
  );
  expect(second).toBeNull();
  await new Promise((r) => setTimeout(r, 400));
  await first!.stop();
  expect(hits.every((h) => h === "GET /ping/fake")).toBe(true);
});

it("AC-41：沒設網址 → 不 fetch、log 沒有錯誤", async () => {
  hits = [];
  logs.length = 0;
  const fetchSpy = vi.spyOn(globalThis, "fetch");
  const w = await m.worker.startWorker(opts(`hc2-${owner.schemaName}`, ""));
  await new Promise((r) => setTimeout(r, 400));
  await w!.stop();
  expect(fetchSpy).not.toHaveBeenCalled();
  expect(hits).toEqual([]);
  expect(logs.filter((l) => /出錯|失敗/.test(l))).toEqual([]);
});
