import { readFile } from "node:fs/promises";

const daemonUrl = process.argv[2];
if (!daemonUrl || !/^http:\/\/127\.0\.0\.1:\d+$/.test(daemonUrl)) {
  throw new Error("Usage: node import-artifacts.mjs http://127.0.0.1:<port>");
}

const imports = [
  {
    projectId: "fju-public-site-20260817",
    source: "/Users/lubaiyu/fju-project/prototypes/public-site/index.html",
  },
  {
    projectId: "fju-student-dashboard-20260817",
    source: "/Users/lubaiyu/fju-project/prototypes/student-dashboard/index.html",
  },
  {
    projectId: "fju-admin-editor-20260817",
    source: "/Users/lubaiyu/fju-project/prototypes/admin-editor/index.html",
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
    const error = new Error(`${init.method ?? "GET"} ${path}: ${response.status} ${JSON.stringify(body)}`);
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

const results = [];
for (const item of imports) {
  const content = await readFile(item.source, "utf8");
  const uploadPath = `/api/projects/${encodeURIComponent(item.projectId)}/files`;
  const common = {
    name: "index.html",
    content,
    overwrite: true,
    source: "manual",
    versionLabel: "OpenAI Codex prototype import",
    versionPrompt: "Imported after Open Design's external Codex runtime failed before producing an artifact.",
  };
  let uploaded;
  try {
    uploaded = await request(uploadPath, {
      method: "POST",
      body: JSON.stringify({ ...common, artifact: true }),
    });
  } catch (error) {
    if (error.status !== 409 || error.body?.error?.code !== "FILE_EXISTS") throw error;
    // createProjectArtifactFile intentionally rejects an existing artifact. A
    // normal file write updates the content while preserving its manifest and
    // lets Open Design capture a new manual HTML version.
    uploaded = await request(uploadPath, {
      method: "POST",
      body: JSON.stringify(common),
    });
  }
  const preview = await request(`/api/projects/${encodeURIComponent(item.projectId)}/preview-url`);
  results.push({
    projectId: item.projectId,
    source: item.source,
    bytes: Buffer.byteLength(content),
    file: uploaded.file,
    preview,
  });
}

process.stdout.write(`${JSON.stringify({ daemonUrl, imports: results }, null, 2)}\n`);
