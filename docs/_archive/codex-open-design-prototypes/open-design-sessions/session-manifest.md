# Open Design session manifest

- Started: 2026-08-17 19:13 Asia/Taipei
- Open Design: 0.19.2, Gatekeeper accepted (Notarized Developer ID)
- Agent: local Codex CLI
- Model: `gpt-5.5`
- Reasoning: `high`
- Optional telemetry: metrics off, content off, artifact manifest off
- Data: fictional prototype data only

| Prototype | Open Design project | Conversation | Native Codex run | Imported preview |
|---|---|---|---|---|
| Public site | `fju-public-site-20260817` | `aa62af4e-1f5d-4e3c-afea-7198da9bd5b4` | `5a057908-f407-4bd1-a9d3-c2b2369a78fb` | `/api/projects/fju-public-site-20260817/preview/d2e33b5a-09fc-4f45-a4a6-2ae3d4657a46/index.html` |
| Student dashboard | `fju-student-dashboard-20260817` | `169947e3-5006-4519-a0f3-2f9013b6ad67` | `4b7114bd-cfc5-4778-a454-14c52fe8db32` | `/api/projects/fju-student-dashboard-20260817/preview/d484c5cf-7e0e-4741-9d40-f880111ffd1b/index.html` |
| Admin editor | `fju-admin-editor-20260817` | `78b35968-8fa1-45a3-8709-af038f657819` | `a17358d8-b065-4f22-ab2a-93bab2f12d8b` | `/api/projects/fju-admin-editor-20260817/preview/1593ec28-0e61-4cb4-a124-f890230d09d3/index.html` |

## Result

- Open Design project and conversation creation: **PASS**.
- Open Design native Codex generation: **FAIL** for all three runs. Each process was killed by `SIGKILL` before the first token and produced zero artifacts. No credential change or retry loop was attempted.
- Recovery path: three isolated OpenAI Codex workers generated the artifacts from the same briefs, and `import-artifacts.mjs` imported them into the original three Open Design projects.
- Independent validation found and fixed one student Dashboard event-delegation bug before the final import; the final artifacts pass 12 rendering checks and 3 end-to-end interaction checks.
- Imported artifact status: **complete**; all three local preview URLs returned HTTP 200.
- Open Design preview runtime: **3/3 PASS** in headless Chrome, including C→B keyboard switching and one representative click interaction per artifact; no runtime or console errors.
- Optional telemetry remained disabled and only fictional data was used.

The three source briefs, reproducible session-creation script, and import script live in this directory. Preview paths are local to the running Open Design daemon.
