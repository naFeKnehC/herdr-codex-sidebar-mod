import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  NO_CWD_KEY,
  buildAgentView,
  dedupeSessions,
  displayNameForCwd,
  groupDirectories,
  inspectCwd,
  normalizeCwdLiteral,
  normalizeSession,
  normalizeSessions,
} from "../mods/herdr-codex-sidebar-mod/helper/lib/normalize.mjs";
import { disambiguateDisplayNames } from "../mods/herdr-codex-sidebar-mod/view-model.mjs";

test("normalizes trailing slash, duplicate slash, backslash, tilde and NFC", () => {
  const home = "/Users/me";
  assert.equal(normalizeCwdLiteral("/tmp/project/", { home }).key, "/tmp/project");
  assert.equal(normalizeCwdLiteral("/tmp//project///", { home }).key, "/tmp/project");
  assert.equal(normalizeCwdLiteral("\\tmp\\project", { home }).key, "/tmp/project");
  assert.equal(normalizeCwdLiteral("~/project", { home }).key, "/Users/me/project");
  assert.equal(normalizeCwdLiteral("~", { home }).key, "/Users/me");
  assert.equal(normalizeCwdLiteral("/", { home }).key, "/");
  assert.equal(
    normalizeCwdLiteral("/tmp/café", { home }).key,
    normalizeCwdLiteral("/tmp/café", { home }).key,
  );
});

test("null, empty and relative cwd go to No directory without guessing home", () => {
  for (const value of [null, "", "   ", "relative/path", "./here", "../up"]) {
    const info = normalizeCwdLiteral(value, { home: "/Users/me" });
    assert.equal(info.key, NO_CWD_KEY, String(value));
    assert.equal(info.cwd, null);
  }
});

test("inspectCwd resolves existing directories through realpath", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-cwd-"));
  const real = join(root, "real");
  const link = join(root, "link");
  await mkdir(real);
  await symlink(real, link);
  const info = inspectCwd(link);
  assert.equal(info.exists, true);
  assert.equal(info.accessible, true);
  assert.equal(info.status, "ok");
  assert.equal(info.key, inspectCwd(real).key);
});

test("inspectCwd keeps literal path for missing symlink targets and is not resumable", async () => {
  const info = inspectCwd("/definitely/not/here/agent-history");
  assert.equal(info.exists, false);
  assert.equal(info.accessible, false);
  assert.equal(info.status, "missing-directory");
  assert.equal(info.key, "/definitely/not/here/agent-history");
});

test("inspectCwd marks permission failures as inaccessible", () => {
  const info = inspectCwd("/tmp/private", {
    realpath: (value) => value,
    stat: () => ({ isDirectory: () => true }),
    access: () => { const error = new Error("denied"); error.code = "EACCES"; throw error; },
  });
  assert.equal(info.exists, true);
  assert.equal(info.accessible, false);
  assert.equal(info.status, "inaccessible");
});

test("groups by exact cwd, never parent directory or project metadata", () => {
  const sessions = normalizeSessions([
    { id: "a", cwd: "/a/b", projectId: "project-x" },
    { id: "b", cwd: "/a/b/c" },
  ], { agent: "codex" });
  assert.equal(sessions.length, 2);
  const directories = groupDirectories("codex", sessions);
  assert.deepEqual(directories.map((group) => group.key).sort(), ["/a/b", "/a/b/c"]);
});

test("same basename in different paths stays separate and gets a distinguishable suffix", () => {
  const view = buildAgentView("codex", [
    { id: "work", cwd: "/work/app" },
    { id: "tmp", cwd: "/tmp/app" },
  ]);
  assert.equal(view.directories.length, 2);
  const names = view.directories.map((group) => group.displayName).sort();
  assert.deepEqual(names, ["tmp/app", "work/app"]);
  assert.ok(view.directories.every((group) => !group.displayName.startsWith("/")));
});

test("no-directory group always sorts last and can only resume via fallback", () => {
  const view = buildAgentView("claude", [
    { id: "no-cwd", cwd: null, lastActivityAt: 999 },
    { id: "with-cwd", cwd: "/tmp/project", lastActivityAt: 1 },
  ]);
  assert.equal(view.directories.at(-1).key, NO_CWD_KEY);
  assert.equal(view.directories.at(-1).displayName, "No directory");
  const session = view.sessions.find((item) => item.id === "no-cwd");
  // cwd 失效不再关闭恢复能力；只是不能原地恢复。
  assert.equal(session.capabilities.resume, true);
  assert.equal(session.capabilities.resumeInPlace, false);
  assert.match(session.unavailableReason, /Working directory/);
});

test("archived, hidden and subagent sessions are filtered out and not counted", () => {
  const view = buildAgentView("hermes", [
    { id: "normal", cwd: "/tmp/a" },
    { id: "archived", cwd: "/tmp/a", archived: true },
    { id: "hidden", cwd: "/tmp/a", hidden: true },
    { id: "child", cwd: "/tmp/a", subagent: true },
    { id: "child2", cwd: "/tmp/a", parentId: "normal" },
  ]);
  assert.deepEqual(view.sessions.map((session) => session.id), ["normal"]);
  assert.equal(view.counts.total, 1);
  assert.equal(view.directories[0].sessions.length, 1);
});

test("dedupes only same agent and same id, keeping the most recent complete record", () => {
  const sessions = dedupeSessions([
    { agent: "claude", id: "same", cwd: "/a", title: "Old", lastActivityAt: 1 },
    { agent: "claude", id: "same", cwd: "/a", title: "New", preview: "p", lastActivityAt: 2 },
    { agent: "codex", id: "same", cwd: "/b", title: "Other agent", lastActivityAt: 3 },
  ]);
  assert.equal(sessions.length, 2);
  const claude = sessions.find((session) => session.agent === "claude");
  assert.equal(claude.title, "New");
  assert.equal(claude.key, "claude:same");
  assert.equal(sessions.find((session) => session.agent === "codex").key, "codex:same");
});

test("sorts directories by activity then path, No directory last", () => {
  const view = buildAgentView("codex", [
    { id: "old", cwd: "/tmp/old", lastActivityAt: 10 },
    { id: "new", cwd: "/tmp/new", lastActivityAt: 20 },
    { id: "none", cwd: null, lastActivityAt: 30 },
  ]);
  assert.deepEqual(view.directories.map((group) => group.key), ["/tmp/new", "/tmp/old", NO_CWD_KEY]);
});

test("missing and inaccessible directories keep sessions and allow fallback resume", () => {
  const missing = normalizeSessions([{ id: "missing", cwd: "/no/such/dir" }], { agent: "claude" })[0];
  assert.equal(missing.cwdInfo.status, "missing-directory");
  assert.equal(missing.capabilities.resume, true);
  assert.equal(missing.capabilities.resumeInPlace, false);

  const inaccessible = normalizeSession(
    { id: "private", cwd: "/private/dir" },
    {
      agent: "claude",
      cwdInfo: { key: "/private/dir", cwd: "/private/dir", exists: true, accessible: false, status: "inaccessible" },
    },
  );
  assert.equal(inaccessible.capabilities.resume, true);
  assert.equal(inaccessible.capabilities.resumeInPlace, false);
  assert.match(inaccessible.unavailableReason, /not accessible/);
});

test("displayNameForCwd handles root, trailing slash and unicode", () => {
  assert.equal(displayNameForCwd("/"), "/");
  assert.equal(displayNameForCwd("/tmp/project/"), "project");
  assert.equal(displayNameForCwd("/tmp/中文目录"), "中文目录");
  assert.equal(displayNameForCwd(null), "No directory");
});

test("disambiguates only conflicting directory names", () => {
  const names = disambiguateDisplayNames([
    { key: "/one/app", cwd: "/one/app", displayName: "app" },
    { key: "/two/app", cwd: "/two/app", displayName: "app" },
    { key: "/unique/other", cwd: "/unique/other", displayName: "other" },
  ]);
  assert.equal(names.get("/one/app"), "one/app");
  assert.equal(names.get("/two/app"), "two/app");
  assert.equal(names.get("/unique/other"), "other");
});

test("uses the first valid cwd and keeps the literal path for resume", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-literal-"));
  const real = join(root, "real");
  await mkdir(real);
  const path = join(root, "link");
  await symlink(real, path);
  const [session] = normalizeSessions([{ id: "s", cwd: path }], { agent: "claude" });
  assert.equal(session.cwd, path);
  assert.equal(session.cwdKey, inspectCwd(real).key);
});

test("large session sets group without O(n^2) metadata work", () => {
  const sessions = Array.from({ length: 500 }, (_, index) => ({
    id: `s-${index}`,
    cwd: `/tmp/project-${index % 20}`,
    lastActivityAt: index,
  }));
  const view = buildAgentView("codex", sessions);
  assert.equal(view.counts.total, 500);
  assert.equal(view.directories.length, 20);
});
