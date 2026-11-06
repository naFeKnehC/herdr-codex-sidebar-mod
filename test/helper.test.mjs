import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { cachePath } from "../mods/herdr-codex-sidebar-mod/helper/lib/cache.mjs";

const repo = fileURLToPath(new URL("..", import.meta.url));
const helper = join(repo, "mods", "herdr-codex-sidebar-mod", "helper", "codex-history.mjs");
const fakeServer = join(repo, "fixtures", "fake-codex-app-server.mjs");

async function temporaryWorkspace({
  withClaude = true,
  withCodex = true,
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "agent-history-helper-"));
  const project = join(root, "project");
  await mkdir(project, { recursive: true });
  const codexHome = join(root, "codex");
  const claudeHome = join(root, "claude");
  const cache = join(root, "cache", "history.json");
  const requests = join(root, "requests.jsonl");
  const wrapper = join(root, "fake-codex");

  if (withCodex) await mkdir(codexHome, { recursive: true });
  if (withClaude) {
    const directory = join(claudeHome, "projects", "-project");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "claude-1.jsonl"), [
      JSON.stringify({ type: "custom-title", customTitle: "Claude chat", sessionId: "claude-1", cwd: project, timestamp: "2026-11-04T10:00:00Z" }),
      JSON.stringify({ type: "user", sessionId: "claude-1", cwd: project, message: { role: "user", content: "Hello from Claude" }, timestamp: "2026-11-04T10:00:01Z" }),
      JSON.stringify({ type: "assistant", sessionId: "claude-1", cwd: project, message: { role: "assistant", content: "Claude answer" }, timestamp: "2026-11-04T10:00:02Z" }),
    ].join("\n"));
  }
  await writeFile(
    wrapper,
    `#!/bin/sh\nexport FAKE_CODEX_REQUESTS='${requests}'\nexec '${process.execPath}' '${fakeServer}' "$@"\n`,
    { mode: 0o755 },
  );
  await chmod(wrapper, 0o755);
  return { root, project, codexHome, claudeHome, cache, requests, wrapper };
}

function runHelper(args, {
  workspace,
  env = {},
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [helper, ...args], {
      env: {
        ...process.env,
        CODEX_HOME: workspace.codexHome,
        CLAUDE_HOME: workspace.claudeHome,
        CODEX_BIN: workspace.wrapper,
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function sync(workspace, env = {}) {
  const result = await runHelper(["sync", "--json", "--cache", workspace.cache], { workspace, env });
  if (result.code !== 0) assert.fail(result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

test("cache default path is the v0.2 history.json location", () => {
  assert.equal(
    cachePath({ home: "/Users/me", appHome: null, env: {} }),
    "/Users/me/.config/herdr-app/data/herdr-agent-history/history.json",
  );
  assert.equal(cachePath({ home: "/Users/me", appHome: null, env: { AGENT_HISTORY_CACHE: "/tmp/x.json" } }), "/tmp/x.json");
});

test("sync returns both agents in schema 2 with cwd directories", async () => {
  const workspace = await temporaryWorkspace();
  const value = await sync(workspace);
  assert.equal(value.schemaVersion, 2);
  assert.ok(value.syncedAt > 0);
  for (const agent of ["claude", "codex"]) {
    assert.equal(value.agents[agent].available, true, agent);
    assert.ok(value.agents[agent].sessions.length >= 1, agent);
    assert.ok(value.directories.some((directory) => directory.agent === agent), agent);
  }
  assert.equal(value.agents.claude.sessions[0].id, "claude-1");
  assert.equal(value.agents.claude.sessions[0].title, "Claude chat");
  assert.ok(value.agents.codex.sessions.some((session) => session.id === "t1"));
  assert.ok(Array.isArray(value.agentStatus.claude.warnings));

  // Codex 只调用 thread/list，不调用 project/list。
  const calls = (await readFile(workspace.requests, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);
  assert.equal(calls.some((call) => call.method === "project/list"), false);
});

test("writes an atomic owner-only cache without transcript bodies", async () => {
  const workspace = await temporaryWorkspace();
  await sync(workspace);
  const info = await stat(workspace.cache);
  assert.equal(info.mode & 0o777, 0o600);
  const raw = await readFile(workspace.cache, "utf8");
  const value = JSON.parse(raw);
  assert.equal(value.schemaVersion, 2);
  assert.equal(/"messages"\s*:/.test(raw), false);
  // 缓存可以保留短 preview，但不能包含完整 assistant 对话。
  assert.equal(raw.includes("Claude answer"), false);
});

test("a failed adapter keeps its previous cache and marks it stale", async () => {
  const workspace = await temporaryWorkspace();
  const first = await sync(workspace);
  assert.ok(first.agents.codex.sessions.length > 0);

  const second = await sync(workspace, { FAKE_CODEX_MODE: "timeout", AGENT_HISTORY_TIMEOUT_MS: "300" });
  assert.equal(second.agents.codex.stale, true);
  assert.ok(second.staleAgents.includes("codex"));
  assert.ok(second.agents.codex.sessions.length > 0);
  assert.ok(second.warnings.some((warning) => /Codex sync failed/.test(warning)));
  assert.equal(second.agents.claude.stale, false);
});

test("a failed first sync returns a readable schema 2 result", async () => {
  const workspace = await temporaryWorkspace({ withClaude: false, withCodex: false });
  await mkdir(workspace.codexHome, { recursive: true });
  const result = await runHelper(["sync", "--json", "--cache", workspace.cache], {
    workspace,
    env: { FAKE_CODEX_MODE: "crash" },
  });
  assert.equal(result.code, 0, result.stderr);
  const value = JSON.parse(result.stdout);
  assert.equal(value.schemaVersion, 2);
  assert.deepEqual(value.sessions, []);
  assert.ok(value.warnings.some((warning) => /Codex sync failed/.test(warning)));
  assert.equal(value.agents.claude.available, false);
});

test("all empty data roots produce empty directories without a fatal error", async () => {
  const workspace = await temporaryWorkspace({ withClaude: false, withCodex: false });
  const value = await sync(workspace);
  assert.equal(value.schemaVersion, 2);
  assert.deepEqual(value.directories, []);
  assert.deepEqual(value.sessions, []);
  assert.equal(value.agents.claude.available, false);
  assert.equal(value.agents.codex.available, false);
});

test("status and reconcile are cache-only and tolerate corrupt or old schema", async () => {
  const workspace = await temporaryWorkspace({ withClaude: false, withCodex: false });
  await mkdir(join(workspace.root, "cache"), { recursive: true });
  await writeFile(workspace.cache, "{ not json");
  const status = await runHelper(["status", "--json", "--cache", workspace.cache], { workspace });
  assert.equal(status.code, 0, status.stderr);
  const empty = JSON.parse(status.stdout);
  assert.equal(empty.schemaVersion, 2);
  assert.deepEqual(empty.sessions, []);

  await writeFile(workspace.cache, JSON.stringify({ schemaVersion: 1, projects: [{ id: "old" }] }));
  const reconcile = await runHelper(["reconcile", "--json", "--cache", workspace.cache], { workspace });
  assert.equal(reconcile.code, 0, reconcile.stderr);
  assert.equal(JSON.parse(reconcile.stdout).schemaVersion, 2);
});

test("a corrupt cache is rebuilt on the next sync", async () => {
  const workspace = await temporaryWorkspace();
  await mkdir(join(workspace.root, "cache"), { recursive: true });
  await writeFile(workspace.cache, "{ not json");
  const value = await sync(workspace);
  assert.equal(value.schemaVersion, 2);
  assert.equal(JSON.parse(await readFile(workspace.cache, "utf8")).schemaVersion, 2);
});

test("concurrent syncs leave a consistent cache", async () => {
  const workspace = await temporaryWorkspace();
  const runs = await Promise.all([
    runHelper(["sync", "--json", "--cache", workspace.cache], { workspace }),
    runHelper(["sync", "--json", "--cache", workspace.cache], { workspace }),
  ]);
  for (const result of runs) assert.equal(result.code, 0, result.stderr);
  const value = JSON.parse(await readFile(workspace.cache, "utf8"));
  assert.equal(value.schemaVersion, 2);
  assert.ok(value.agents.codex.sessions.length > 0);
});

test("previews both agents without launching them", async () => {
  const workspace = await temporaryWorkspace();
  // Codex rollout for preview.
  const directory = join(workspace.codexHome, "sessions", "2026", "11", "04");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "rollout-t1.jsonl"), `${JSON.stringify({
    type: "response_item",
    payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Codex preview text" }] },
  })}\n`);
  const claude = await runHelper(["preview", "--agent", "claude", "--session", "claude-1"], { workspace });
  assert.equal(claude.code, 0, claude.stderr);
  assert.match(claude.stdout, /Claude history: Claude chat/);
  assert.match(claude.stdout, /Hello from Claude/);

  const codex = await runHelper(["preview", "--agent", "codex", "--session", "t1"], { workspace });
  assert.equal(codex.code, 0, codex.stderr);
  assert.match(codex.stdout, /Codex history/);
  assert.match(codex.stdout, /Codex preview text/);
});

test("unknown preview agent fails with a readable message", async () => {
  const workspace = await temporaryWorkspace();
  const result = await runHelper(["preview", "--agent", "other", "--session", "x"], { workspace });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /Unknown agent/);
});
