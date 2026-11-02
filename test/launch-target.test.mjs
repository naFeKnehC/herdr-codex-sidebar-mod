import test from "node:test";
import assert from "node:assert/strict";
import {
  findProjectSpace,
  launchCwd,
  previewShellCommand,
  resumeShellCommand,
  shellQuote,
} from "../mods/herdr-codex-sidebar-mod/launch-target.mjs";

test("uses the assigned project root when a thread has a stale cwd", () => {
  const cwd = launchCwd(
    { roots: ["/Users/me/project/herdr-codex-sidebar-mod"] },
    { cwd: "/Users/me/Documents/Codex/2026-10-30/bang" },
    "/Users/me",
  );
  assert.equal(cwd, "/Users/me/project/herdr-codex-sidebar-mod");
});

test("keeps a thread cwd that is inside the assigned project", () => {
  const cwd = launchCwd(
    { roots: ["/Users/me/project/app"] },
    { cwd: "/Users/me/project/app/packages/web" },
    "/Users/me",
  );
  assert.equal(cwd, "/Users/me/project/app/packages/web");
});

test("keeps the thread cwd for projectless chats", () => {
  const cwd = launchCwd(
    { roots: [] },
    { cwd: "/Users/me/Documents/Codex/2026-10-30/bang" },
    "/Users/me",
  );
  assert.equal(cwd, "/Users/me/Documents/Codex/2026-10-30/bang");
});

test("reuses the Unassigned space for projectless chats", () => {
  const spaces = [
    { id: "project", name: "herdr-codex-sidebar-mod", folder: "/Users/me/project/app", tabs: [] },
    { id: "unassigned", name: "Unassigned", folder: "/Users/me", tabs: [] },
  ];
  const space = findProjectSpace(
    spaces,
    [],
    { id: null, name: "Unassigned", roots: [] },
    "/Users/me/Documents/Codex/2026-10-30/bang",
  );
  assert.equal(space.id, "unassigned");
});

test("never places a projectless chat in a project space with the same cwd", () => {
  const spaces = [{
    id: "project",
    name: "herdr-codex-sidebar-mod",
    folder: "/Users/me/Documents/Codex/2026-10-30/bang",
    tabs: [{ id: "tab" }],
  }];
  const panes = [{ tab: "tab", cwd: "/Users/me/Documents/Codex/2026-10-30/bang" }];
  const space = findProjectSpace(
    spaces,
    panes,
    { id: null, name: "Unassigned", roots: [] },
    "/Users/me/Documents/Codex/2026-10-30/bang",
  );
  assert.equal(space, null);
});

test("prefers the Unassigned space with the matching folder", () => {
  const spaces = [
    { id: "other", name: "Unassigned", folder: "/Users/me/other", tabs: [] },
    { id: "matching", name: "Unassigned", folder: "/Users/me/bang", tabs: [] },
  ];
  const space = findProjectSpace(
    spaces,
    [],
    { id: null, name: "Unassigned", roots: [] },
    "/Users/me/bang",
  );
  assert.equal(space.id, "matching");
});

test("prefers a space owned by the project over a stale cwd match", () => {
  const spaces = [
    { id: "old", folder: "/Users/me/Documents/Codex/2026-10-30/bang", tabs: [] },
    { id: "current", folder: "/Users/me/project/herdr-codex-sidebar-mod", tabs: [] },
  ];
  const space = findProjectSpace(
    spaces,
    [],
    { roots: ["/Users/me/project/herdr-codex-sidebar-mod"] },
    "/Users/me/Documents/Codex/2026-10-30/bang",
  );
  assert.equal(space.id, "current");
});

test("reuses a project space through its terminal labels when its folder is stale", () => {
  const spaces = [{
    id: "current",
    name: "herdr-codex-sidebar-mod",
    folder: "/Users/me/Documents/Codex/2026-10-30/bang",
    tabs: [{ id: "tab", terminals: [{ terminal: "t22" }] }],
  }];
  const terminals = [{
    address: "t22",
    labels: { "codex.project.id": "project-1" },
  }];
  const space = findProjectSpace(
    spaces,
    [],
    { id: "project-1", name: "herdr-codex-sidebar-mod", roots: ["/Users/me/project/herdr-codex-sidebar-mod"] },
    "/Users/me/project/herdr-codex-sidebar-mod",
    terminals,
  );
  assert.equal(space.id, "current");
});

test("reuses the only space with the project name", () => {
  const spaces = [{
    id: "current",
    name: "herdr-codex-sidebar-mod",
    folder: "/Users/me/Documents/Codex/2026-10-30/bang",
    tabs: [],
  }];
  const space = findProjectSpace(
    spaces,
    [],
    { id: "project-1", name: "herdr-codex-sidebar-mod", roots: ["/Users/me/project/herdr-codex-sidebar-mod"] },
    "/Users/me/project/herdr-codex-sidebar-mod",
  );
  assert.equal(space.id, "current");
});

test("finds a project space through a live pane under its root", () => {
  const spaces = [{ id: "current", folder: "", tabs: [{ id: "tab" }] }];
  const panes = [{ tab: "tab", cwd: "/Users/me/project/app/packages/web" }];
  const space = findProjectSpace(spaces, panes, { roots: ["/Users/me/project/app"] }, null);
  assert.equal(space.id, "current");
});

test("quotes shell paths and thread ids for the placeholder tab", () => {
  assert.equal(shellQuote("/tmp/it's here"), "'/tmp/it'\\''s here'");
  assert.equal(
    resumeShellCommand("/tmp/it's here", "thread-1"),
    "cd '/tmp/it'\\''s here' && codex resume 'thread-1'",
  );
});

test("builds a non-agent transcript preview command", () => {
  assert.equal(
    previewShellCommand("/opt/codex-history", "/tmp/project", "thread-1", {
      path: "/tmp/thread.jsonl",
      title: "A title",
    }),
    "cd '/tmp/project' && '/opt/codex-history' preview --thread 'thread-1' --cwd '/tmp/project' --path '/tmp/thread.jsonl' --title 'A title'",
  );
});
