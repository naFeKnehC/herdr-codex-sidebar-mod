import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  isUserThread,
  readCodexPreview,
  readCodexSessions,
  threadToSession,
} from "../mods/herdr-codex-sidebar-mod/helper/lib/adapters/codex.mjs";
import { normalizeSessions } from "../mods/herdr-codex-sidebar-mod/helper/lib/normalize.mjs";

const repo = fileURLToPath(new URL("..", import.meta.url));
const fakeServer = join(repo, "fixtures", "fake-codex-app-server.mjs");

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "codex-adapter-"));
  const codexHome = join(root, "codex");
  const requests = join(root, "requests.jsonl");
  const wrapper = join(root, "fake-codex");
  await mkdir(codexHome, { recursive: true });
  await writeFile(
    wrapper,
    `#!/bin/sh\nexport FAKE_CODEX_REQUESTS='${requests}'\nexport FAKE_CODEX_MODE='${process.env.FAKE_CODEX_MODE || "normal"}'\nexec '${process.execPath}' '${fakeServer}' "$@"\n`,
    { mode: 0o755 },
  );
  await chmod(wrapper, 0o755);
  return { root, codexHome, requests, wrapper };
}

test("lists threads with only thread/list and paginates all pages", async () => {
  const { codexHome, requests, wrapper } = await workspace();
  const result = await readCodexSessions({ codexHome, codex: wrapper, timeoutMs: 5_000 });
  assert.equal(result.available, true);
  assert.deepEqual(result.sessions.map((session) => session.id).sort(), ["t1", "t2", "t3"]);

  const calls = (await readFile(requests, "utf8")).trim().split("\n").map(JSON.parse);
  assert.ok(calls.some((call) => call.method === "initialize"));
  assert.equal(calls.some((call) => call.method === "project/list"), false);
  const lists = calls.filter((call) => call.method === "thread/list");
  assert.equal(lists.length, 2);
  assert.equal(lists[0].params.archived, false);
  assert.equal(lists[0].params.useStateDbOnly, true);
  assert.equal(lists[1].params.cursor, "threads-2");
});

test("filters non-user sources, child threads, archived threads and dedupes ids", async () => {
  const key = "FAKE_CODEX_MODE";
  const previous = process.env[key];
  process.env[key] = "filters";
  try {
    const { codexHome, wrapper } = await workspace();
    const result = await readCodexSessions({ codexHome, codex: wrapper, timeoutMs: 5_000 });
    assert.equal(result.sessions.some((session) => session.id === "guardian"), false);
    assert.equal(result.sessions.some((session) => session.id === "child"), false);
    assert.equal(result.sessions.some((session) => session.id === "archived"), false);
    const normalized = normalizeSessions(result.sessions, { agent: "codex" });
    assert.deepEqual(normalized.map((session) => session.id).sort(), ["dupe", "user-ok"]);
    assert.equal(normalized.find((session) => session.id === "dupe").title, "Newer dupe");
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
});

test("isUserThread requires user source and no parent", () => {
  assert.equal(isUserThread({ id: "a" }), true);
  assert.equal(isUserThread({ id: "a", threadSource: "user" }), true);
  assert.equal(isUserThread({ id: "a", threadSource: "guardian_review" }), false);
  assert.equal(isUserThread({ id: "a", thread_source: "subagent" }), false);
  assert.equal(isUserThread({ id: "a", parentThreadId: "parent" }), false);
  assert.equal(isUserThread({ id: "a", archived: true }), false);
  assert.equal(isUserThread({}), false);
});

test("normalizes seconds, milliseconds, ISO and numeric string timestamps", () => {
  const base = { id: "t", cwd: "/tmp" };
  assert.equal(threadToSession({ ...base, updatedAt: 1_800_000_000 }).updatedAt, 1_800_000_000);
  assert.equal(threadToSession({ ...base, updatedAt: 1_800_000_000_000 }).updatedAt, 1_800_000_000);
  assert.equal(threadToSession({ ...base, updatedAt: "1800000000" }).updatedAt, 1_800_000_000);
  assert.equal(threadToSession({ ...base, updatedAt: "2026-11-04T00:00:00Z" }).updatedAt, Date.parse("2026-11-04T00:00:00Z") / 1000);
  assert.equal(threadToSession({ ...base, updatedAt: "not-a-date" }).updatedAt, 0);
});

test("uses name > title > preview for thread titles and ignores project metadata", () => {
  assert.equal(threadToSession({ id: "t", name: "Name", title: "Title", preview: "Preview", projectId: "p" }).title, "Name");
  assert.equal(threadToSession({ id: "t", title: "Title", preview: "Preview" }).title, "Title");
  assert.equal(threadToSession({ id: "t", preview: "Preview\nsecond" }).title, "Preview");
  const session = threadToSession({ id: "t", projectId: "some-project", runtimeWorkspaceRoots: ["/tmp/root"] });
  assert.equal(session.cwd, null);
  assert.equal(session.projectId, undefined);
});

test("reports an unavailable data root without launching app-server", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-missing-"));
  const result = await readCodexSessions({
    codexHome: join(root, "missing"),
    codex: "/definitely/missing",
    timeoutMs: 100,
  });
  assert.equal(result.available, false);
  assert.match(result.reason, /not found/);
  assert.deepEqual(result.sessions, []);
});

test("app-server failure rejects so the helper can keep stale data", async () => {
  const key = "FAKE_CODEX_MODE";
  const previous = process.env[key];
  process.env[key] = "crash";
  try {
    const { codexHome, wrapper } = await workspace();
    await assert.rejects(
      readCodexSessions({ codexHome, codex: wrapper, timeoutMs: 5_000 }),
      /exited|wrong command/i,
    );
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
});

test("reads a local rollout preview without starting Codex", async () => {
  const { codexHome } = await workspace();
  const directory = join(codexHome, "sessions", "2026", "11", "04");
  await mkdir(directory, { recursive: true });
  const path = join(directory, "rollout-x1.jsonl");
  await writeFile(path, `${JSON.stringify({
    type: "response_item",
    payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Hello" }] },
  })}\n${JSON.stringify({
    type: "response_item",
    payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Hi" }] },
  })}\n`);
  const preview = await readCodexPreview({ codexHome, sessionId: "x1" });
  assert.equal(preview.path, path);
  assert.deepEqual(preview.messages.map((message) => message.text), ["Hello", "Hi"]);
});

test("keeps the reported rollout path and only enables preview for local files", async () => {
  const key = "FAKE_CODEX_MODE";
  const previous = process.env[key];
  process.env[key] = "paths";
  try {
    const { codexHome, wrapper } = await workspace();
    const directory = join(codexHome, "project", "sessions");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "rollout-local.jsonl"), "{" + "}\n");
    await writeFile(join(directory, "rollout-compressed.jsonl.zst"), "not read by this test");

    const result = await readCodexSessions({ codexHome, codex: wrapper, timeoutMs: 5_000 });
    const byId = Object.fromEntries(result.sessions.map((session) => [session.id, session]));
    assert.equal(byId.local.path, join(directory, "rollout-local.jsonl"));
    assert.equal(byId.local.capabilities.preview, true);
    assert.equal(byId.compressed.capabilities.preview, true);
    assert.equal(byId.cloud.path, null);
    assert.equal(byId.cloud.capabilities.preview, false);
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
});

test("threadToSession preserves only a non-empty rollout path", () => {
  assert.equal(threadToSession({ id: "t", path: " /tmp/rollout.jsonl " }).path, "/tmp/rollout.jsonl");
  assert.equal(threadToSession({ id: "t", path: "   " }).path, null);
  assert.equal(threadToSession({ id: "t" }).path, null);
});
