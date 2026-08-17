import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const daemonUrl = process.argv[2];
if (!daemonUrl || !/^http:\/\/127\.0\.0\.1:\d+$/.test(daemonUrl)) {
  throw new Error("Usage: node create-sessions.mjs http://127.0.0.1:<port>");
}

const here = dirname(fileURLToPath(import.meta.url));
const sessions = [
  {
    id: "fju-public-site-20260817",
    name: "FJU IM 公開前台原型",
    skillId: "design-taste-frontend",
    promptFile: "public-site.md",
  },
  {
    id: "fju-student-dashboard-20260817",
    name: "FJU IM 學生 Dashboard 原型",
    skillId: "artifacts-builder",
    promptFile: "student-dashboard.md",
  },
  {
    id: "fju-admin-editor-20260817",
    name: "FJU IM 管理員專題事務編輯器原型",
    skillId: "artifacts-builder",
    promptFile: "admin-editor.md",
  },
];

async function request(path, init = {}) {
  const response = await fetch(`${daemonUrl}${path}`, {
    ...init,
    headers: {
      Origin: daemonUrl,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`${init.method ?? "GET"} ${path}: ${response.status} ${JSON.stringify(body)}`);
  }
  return body;
}

const results = await Promise.all(
  sessions.map(async (session) => {
    const prompt = await readFile(join(here, session.promptFile), "utf8");
    const created = await request("/api/projects", {
      method: "POST",
      body: JSON.stringify({
        id: session.id,
        name: session.name,
        skillId: session.skillId,
        designSystemId: "default",
        pendingPrompt: prompt,
        metadata: { kind: "prototype", product: "fju-im-project" },
        customInstructions: "Traditional Chinese. Fake data only. Produce a self-contained HTML prototype and verify all variants before finishing.",
        skipDiscoveryBrief: true,
        conversationMode: "design",
      }),
    });

    const run = await request("/api/runs", {
      method: "POST",
      body: JSON.stringify({
        projectId: session.id,
        conversationId: created.conversationId,
        message: prompt,
        skillId: session.skillId,
        designSystemId: "default",
        agentId: "codex",
        model: "gpt-5.5",
        reasoning: "high",
        sessionMode: "design",
      }),
    });

    return {
      projectId: session.id,
      conversationId: created.conversationId,
      runId: run.runId,
      status: run.status ?? "started",
    };
  }),
);

process.stdout.write(`${JSON.stringify({ daemonUrl, sessions: results }, null, 2)}\n`);
