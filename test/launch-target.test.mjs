import test from "node:test";
import assert from "node:assert/strict";
import {
  findDirectorySpace,
  findDirectorySpaceMatches,
  findProjectSpace,
  previewAvailability,
  previewShellCommand,
  resolveEffectiveCwd,
  resumeArgv,
  resumeAvailability,
  resumeCommand,
  resumeShellCommand,
  shellQuote,
} from "../mods/herdr-codex-sidebar-mod/launch-target.mjs";
import { NO_CWD_KEY } from "../mods/herdr-codex-sidebar-mod/view-model.mjs";

test("reuses a space whose folder exactly equals cwd", () => {
  const spaces = [
    { id: "parent", folder: "/Users/me/project", tabs: [] },
    { id: "exact", folder: "/Users/me/project/app", tabs: [] },
  ];
  assert.equal(findDirectorySpace(spaces, [], [], "/Users/me/project/app/").id, "exact");
});

test("does not match a parent folder for a child cwd", () => {
  const spaces = [{ id: "parent", folder: "/a", tabs: [] }];
  assert.equal(findDirectorySpace(spaces, [], [], "/a/b"), null);
});

test("does not confuse same-basename different paths", () => {
  const spaces = [
    { id: "work", folder: "/work/app", tabs: [] },
    { id: "tmp", folder: "/tmp/app", tabs: [] },
  ];
  assert.equal(findDirectorySpace(spaces, [], [], "/tmp/app").id, "tmp");
  assert.equal(findDirectorySpace(spaces, [], [], "/work/app").id, "work");
});

test("chooses deterministically when two spaces share one folder", () => {
  const spaces = [
    { id: "b", folder: "/tmp/app", tabs: [] },
    { id: "a", folder: "/tmp/app", tabs: [] },
  ];
  assert.equal(findDirectorySpace(spaces, [], [], "/tmp/app").id, "a");
});

test("finds a space through an exact-cwd pane and ignores remote spaces", () => {
  const spaces = [
    { id: "remote", machine: "build-box", folder: "/tmp/app", tabs: [{ id: "remote-tab" }] },
    { id: "local", machine: null, folder: "", tabs: [{ id: "tab" }] },
  ];
  const panes = [
    { tab: "tab", pane: "p1", cwd: "/tmp/app" },
    { tab: "remote-tab", pane: "p2", cwd: "/tmp/app" },
  ];
  assert.equal(findDirectorySpace(spaces, panes, [], "/tmp/app").id, "local");
});

test("never creates a space target for no-cwd sessions", () => {
  const spaces = [{ id: "home", folder: "/Users/me", tabs: [] }];
  assert.equal(findDirectorySpace(spaces, [], [], null), null);
  assert.equal(findDirectorySpace(spaces, [], [], NO_CWD_KEY), null);
});

test("returns all exact candidates and skips folders that no longer exist", () => {
  const spaces = [
    { id: "gone", folder: "/tmp/gone", tabs: [] },
    { id: "b", folder: "/tmp/app", tabs: [] },
    { id: "a", folder: "/tmp/app", tabs: [] },
  ];
  const matches = findDirectorySpaceMatches(spaces, [], [], "/tmp/app");
  assert.deepEqual(matches.map((match) => match.space.id), ["a", "b"]);
  assert.deepEqual(matches.map((match) => match.folder), ["/tmp/app", "/tmp/app"]);

  const existing = findDirectorySpaceMatches(spaces, [], [], "/tmp/gone", {
    folderExists: (path) => path !== "/tmp/gone",
  });
  assert.deepEqual(existing, []);
});

test("legacy findProjectSpace uses exact cwd and ignores project roots", () => {
  const spaces = [{ id: "project", folder: "/project", tabs: [] }];
  assert.equal(findProjectSpace(spaces, [], { roots: ["/project"] }, "/project/sub"), null);
  assert.equal(findProjectSpace(spaces, [], { roots: ["/project"] }, "/project").id, "project");
});

test("quotes shell paths and session ids without injection", () => {
  assert.equal(shellQuote("/tmp/it's here"), "'/tmp/it'\\''s here'");
  assert.equal(shellQuote("$(rm -rf /)"), "'$(rm -rf /)'");
  assert.equal(shellQuote("`whoami`"), "'`whoami`'");
});

test("direct resume commands leave cwd to the tab folder", () => {
  assert.equal(
    resumeCommand("claude", { bin: "/opt/claude", cwd: "/tmp/it's here", sessionId: "c1" }),
    "'/opt/claude' --resume 'c1'",
  );
  assert.equal(
    resumeCommand("codex", { bin: "/opt/codex", cwd: "/tmp/project", sessionId: "x1" }),
    "'/opt/codex' --no-daemon -C '/tmp/project' resume 'x1'",
  );
  assert.equal(
    resumeCommand("hermes", { bin: "/opt/hermes", cwd: "/tmp/project", sessionId: "h1" }),
    "'/opt/hermes' --resume 'h1'",
  );
  assert.throws(() => resumeCommand("other", { bin: "x", cwd: "/tmp", sessionId: "1" }));
});

test("fallback resume commands never carry the original cwd", () => {
  // Codex fallback 明确不带 -C；目录由 tab.new 的 folder 决定。
  assert.equal(
    resumeCommand("codex", { bin: "/opt/codex", cwd: "/tmp/fallback", sessionId: "x1", mode: "fallback" }),
    "'/opt/codex' --no-daemon resume 'x1'",
  );
  assert.equal(
    resumeCommand("codex", { bin: "/opt/codex", cwd: "/tmp/fallback", sessionId: "x1", mode: "override" }),
    "'/opt/codex' --no-daemon resume 'x1'",
  );
  assert.equal(
    resumeCommand("hermes", { bin: "/opt/hermes", cwd: "/tmp/fallback", sessionId: "h1", mode: "fallback" }),
    "'/opt/hermes' --no-restore-cwd --resume 'h1'",
  );
  assert.equal(
    resumeCommand("claude", { bin: "/opt/claude", cwd: "/tmp/fallback", sessionId: "c1", mode: "fallback" }),
    "'/opt/claude' --resume 'c1'",
  );
});

test("builds argv for direct tab launches", () => {
  assert.deepEqual(resumeArgv("claude", { bin: "/opt/claude", cwd: "/tmp/a", sessionId: "c1" }), [
    "/opt/claude", "--resume", "c1",
  ]);
  assert.deepEqual(resumeArgv("codex", { bin: "/opt/codex", cwd: "/tmp/a", sessionId: "x1" }), [
    "/opt/codex", "--no-daemon", "-C", "/tmp/a", "resume", "x1",
  ]);
  assert.deepEqual(resumeArgv("hermes", { bin: "/opt/hermes", cwd: "/tmp/a", sessionId: "h1" }), [
    "/opt/hermes", "--resume", "h1",
  ]);
});

test("builds argv for fallback launches without -C and with Hermes no-restore", () => {
  assert.deepEqual(resumeArgv("codex", {
    bin: "/opt/codex", cwd: "/tmp/fallback", sessionId: "x1", mode: "fallback",
  }), ["/opt/codex", "--no-daemon", "resume", "x1"]);
  assert.deepEqual(resumeArgv("hermes", {
    bin: "/opt/hermes", cwd: "/tmp/fallback", sessionId: "h1", mode: "override",
  }), ["/opt/hermes", "--no-restore-cwd", "--resume", "h1"]);
  assert.deepEqual(resumeArgv("claude", {
    bin: "/opt/claude", cwd: "/tmp/fallback", sessionId: "c1", mode: "fallback",
  }), ["/opt/claude", "--resume", "c1"]);
});

test("wraps resume with cd and an agent.resume.exit label", () => {
  const wrapped = resumeShellCommand("claude", "/opt/claude", "/tmp/project", "c1", {
    hcBin: "/opt/herdr/bin/hc",
    terminal: "t7",
  });
  assert.match(wrapped, /^sh -c '/);
  assert.match(wrapped, /cd '\\''\/tmp\/project'\\''/);
  assert.match(wrapped, /--resume/);
  assert.match(wrapped, /agent\.resume\.exit=\$status/);
});

test("fallback placeholder explicitly cds into the fallback directory", () => {
  const command = resumeShellCommand("codex", "/opt/codex", "/tmp/fallback", "x1", { mode: "fallback" });
  assert.equal(command, "cd '/tmp/fallback' && '/opt/codex' --no-daemon resume 'x1'");
  const wrapped = resumeShellCommand("hermes", "/opt/hermes", "/tmp/fallback", "h1", {
    mode: "fallback",
    hcBin: "/opt/herdr/bin/hc",
    terminal: "t7",
  });
  assert.match(wrapped, /cd '\\''\/tmp\/fallback'\\''/);
  assert.match(wrapped, /--no-restore-cwd/);
  assert.match(wrapped, /agent\.resume\.exit=\$status/);
});

test("preview is read-only and does not cd into a possibly missing cwd", () => {
  const command = previewShellCommand("/opt/agent-history", {
    agent: "claude",
    sessionId: "c1",
    cwd: "/tmp/missing",
    path: "/tmp/c1.jsonl",
    title: "A title",
  });
  assert.doesNotMatch(command, /^cd /);
  assert.equal(
    command,
    "'/opt/agent-history' preview --agent 'claude' --session 'c1' --cwd '/tmp/missing' --path '/tmp/c1.jsonl' --title 'A title'",
  );
  const wrapped = previewShellCommand("/opt/agent-history", {
    agent: "hermes",
    sessionId: "h1",
    cwd: null,
    hcBin: "/opt/herdr/bin/hc",
    terminal: "t7",
  });
  assert.match(wrapped, /^sh -c '/);
  assert.match(wrapped, /agent\.preview\.exit=\$status/);
  assert.match(wrapped, /--agent '\\''hermes'\\''/);
});

const okSession = {
  id: "s1",
  cwd: "/tmp/project",
  cwdKey: "/tmp/project",
  cwdInfo: {
    key: "/tmp/project",
    cwd: "/tmp/project",
    exists: true,
    accessible: true,
    status: "ok",
  },
  capabilities: { resume: true },
  unavailableReason: null,
};

const missingSession = {
  ...okSession,
  cwd: "/tmp/gone",
  cwdKey: "/tmp/gone",
  cwdInfo: {
    key: "/tmp/gone",
    cwd: "/tmp/gone",
    exists: false,
    accessible: false,
    status: "missing-directory",
  },
  unavailableReason: "Working directory does not exist",
};

test("resume availability resolves original, fallback and required states", () => {
  assert.deepEqual(resumeAvailability({ kind: "claude", session: okSession, binary: "/opt/claude" }), {
    ok: true,
    mode: "original",
    effectiveCwd: "/tmp/project",
    needsFallback: false,
    reason: null,
  });

  assert.deepEqual(resumeAvailability({
    kind: "codex",
    session: missingSession,
    binary: "/opt/codex",
    fallback: { cwd: "/tmp/fallback", valid: true },
  }), {
    ok: true,
    mode: "fallback",
    effectiveCwd: "/tmp/fallback",
    needsFallback: false,
    reason: null,
  });

  assert.deepEqual(resumeAvailability({
    kind: "claude",
    session: missingSession,
    binary: "/opt/claude",
  }), {
    ok: false,
    mode: "fallback-required",
    effectiveCwd: null,
    needsFallback: true,
    reason: "Fallback directory required",
  });

  assert.equal(resumeAvailability({
    kind: "claude",
    session: missingSession,
    binary: "/opt/claude",
    strictResume: true,
  }).mode, "preview-only");
});

test("unavailable only covers missing binary or an adapter that forbids resume", () => {
  const noBinary = resumeAvailability({ kind: "claude", session: okSession, binary: null });
  assert.equal(noBinary.mode, "unavailable");
  assert.match(noBinary.reason, /executable not found/);

  const forbidden = resumeAvailability({
    kind: "claude",
    session: { ...okSession, capabilities: { resume: false }, unavailableReason: "Data is incomplete" },
    binary: "/opt/claude",
  });
  assert.equal(forbidden.mode, "unavailable");
  assert.match(forbidden.reason, /incomplete/);

  assert.equal(resumeAvailability({ kind: "claude", session: {}, binary: "/opt/claude" }).mode, "unavailable");
  assert.equal(resumeAvailability({ kind: "claude", session: okSession, binary: "/opt/claude" }).mode, "original");
});

test("resolveEffectiveCwd follows override -> original -> strict -> fallback", () => {
  const override = resolveEffectiveCwd({
    session: missingSession,
    override: { cwd: "/tmp/moved", valid: true },
    fallback: { cwd: "/tmp/fallback", valid: true },
  });
  assert.deepEqual(override, {
    cwd: "/tmp/moved", source: "override", mode: "override", needsUserInput: false, reason: null,
  });

  const original = resolveEffectiveCwd({ session: okSession, fallback: { cwd: "/tmp/fallback", valid: true } });
  assert.equal(original.mode, "original");
  assert.equal(original.cwd, "/tmp/project");

  const strict = resolveEffectiveCwd({
    session: missingSession,
    fallback: { cwd: "/tmp/fallback", valid: true },
    strictResume: true,
  });
  assert.equal(strict.mode, "preview-only");
  assert.equal(strict.cwd, null);
  assert.equal(strict.needsUserInput, false);

  const fallback = resolveEffectiveCwd({
    session: missingSession,
    fallback: { cwd: "/tmp/fallback", valid: true },
  });
  assert.equal(fallback.mode, "fallback");
  assert.equal(fallback.cwd, "/tmp/fallback");

  const required = resolveEffectiveCwd({ session: missingSession });
  assert.equal(required.mode, "fallback-required");
  assert.equal(required.needsUserInput, true);
  assert.match(required.reason, /does not exist/);
});

test("preview availability does not require cwd or binary", () => {
  assert.deepEqual(previewAvailability({ id: "s", capabilities: { preview: true } }), { ok: true, reason: null });
  assert.equal(previewAvailability({ id: "s", capabilities: { preview: false } }).ok, false);
  assert.equal(previewAvailability({}).ok, false);
});
