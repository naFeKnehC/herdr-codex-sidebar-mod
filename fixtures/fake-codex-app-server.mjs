#!/usr/bin/env node
// A small `codex app-server --stdio` fixture for helper contract tests.
// Behavior is selected with FAKE_CODEX_MODE:
//   normal | projects-missing | request-errors | timeout | crash | malformed
import readline from "node:readline";

const mode = process.env.FAKE_CODEX_MODE || "normal";
const requestsPath = process.env.FAKE_CODEX_REQUESTS || null;
const home = process.env.CODEX_HOME || "";
const root = home ? `${home}/project` : "/tmp/project";
const otherRoot = home ? `${home}/other` : "/tmp/other";
const projects = [
  { id: "p1", name: "Project", roots: [{ path: root }], position: 0 },
];
const threads = [
  { id: "t1", projectId: "p1", cwd: root, name: "First", createdAt: 1_800_000_000, updatedAt: 1_800_000_100 },
  { id: "t2", cwd: otherRoot, name: "Second", createdAt: 1_800_000_200, updatedAt: 1_800_000_300 },
  { id: "t3", cwd: root, name: "Third", createdAt: 1_800_000_400, updatedAt: 1_800_000_500 },
];
const pathThreads = [
  { id: "local", cwd: root, name: "Local rollout", path: `${root}/sessions/rollout-local.jsonl` },
  { id: "compressed", cwd: root, name: "Compressed rollout", path: `${root}/sessions/rollout-compressed.jsonl` },
  { id: "cloud", cwd: root, name: "Cloud only" },
];
const filterThreads = [
  { id: "user-ok", cwd: root, name: "User thread", threadSource: "user", createdAt: 1_800_000_000, updatedAt: 1_800_000_900 },
  { id: "guardian", cwd: root, name: "Guardian review", threadSource: "guardian_review", createdAt: 1_800_000_100 },
  { id: "child", cwd: root, name: "Child thread", threadSource: "user", parentThreadId: "user-ok", createdAt: 1_800_000_200 },
  { id: "archived", cwd: root, name: "Archived thread", archived: true, createdAt: 1_800_000_300 },
  { id: "dupe", cwd: root, name: "Older dupe", threadSource: "user", createdAt: 1_800_000_400, updatedAt: 1_800_000_410 },
  { id: "dupe", cwd: root, name: "Newer dupe", threadSource: "user", createdAt: 1_800_000_400, updatedAt: 1_800_000_420 },
];

async function record(id, method, params) {
  if (!requestsPath) return;
  const { appendFile } = await import("node:fs/promises");
  await appendFile(requestsPath, `${JSON.stringify({ id, method, params })}\n`);
}

if (mode === "crash") {
  process.stderr.write("fake app-server: wrong command\n");
  process.exit(2);
}

const input = readline.createInterface({ input: process.stdin });
input.on("line", async (line) => {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  if (request.id === undefined) return;
  await record(request.id, request.method, request.params);
  if (mode === "malformed") process.stdout.write("not json\n");
  if (mode === "timeout") return;

  const reply = (result) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
  const fail = (code, message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code, message } })}\n`);

  if (request.method === "initialize") return reply({ userAgent: "fake" });
  if (request.method === "project/list") {
    if (mode === "projects-missing") return fail(-32601, "method not found");
    if (mode === "request-errors") return fail(-32000, "project store unavailable");
    if (request.params?.cursor === "projects-2") return reply({ data: [], nextCursor: null });
    return reply({ data: projects, nextCursor: "projects-2" });
  }
  if (request.method === "thread/list") {
    if (mode === "request-errors") return fail(-32000, "thread store unavailable");
    if (mode === "filters") return reply({ data: filterThreads, nextCursor: null });
    if (mode === "paths") return reply({ data: pathThreads, nextCursor: null });
    if (request.params?.cursor === "threads-2") return reply({ data: [threads[2]], nextCursor: null });
    if (request.params?.cursor === "repeat") return reply({ data: [], nextCursor: "threads-2" });
    return reply({ data: threads.slice(0, 2), nextCursor: "threads-2" });
  }
  return fail(-32601, `method not found: ${request.method}`);
});
