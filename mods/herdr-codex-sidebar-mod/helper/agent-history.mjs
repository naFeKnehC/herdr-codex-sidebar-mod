#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { AGENTS, AGENT_NAMES, buildAgentView } from "../view-model.mjs";
import { cachePath, emptyHistory, readCache, writeCacheAtomic } from "./lib/cache.mjs";
import { agentViewFor } from "./lib/normalize.mjs";
import { detectBinary, errorMessage } from "./lib/adapters/common.mjs";
import { readClaudePreview, readClaudeSessions } from "./lib/adapters/claude.mjs";
import { readCodexPreview, readCodexSessions } from "./lib/adapters/codex.mjs";
import { readHermesPreview, readHermesSessions } from "./lib/adapters/hermes.mjs";
import { renderTranscript } from "./lib/transcript.mjs";

const now = () => Math.floor(Date.now() / 1000);

const BOOLEAN_FLAGS = new Set(["--json", "--help"]);

function parseArgs(argv) {
  const values = { flags: new Map(), positionals: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token.startsWith("--")) {
      const equals = token.indexOf("=");
      const name = equals >= 0 ? token.slice(0, equals) : token;
      if (equals >= 0) {
        values.flags.set(name, token.slice(equals + 1));
      } else if (BOOLEAN_FLAGS.has(name)
        || argv[index + 1] === undefined
        || argv[index + 1].startsWith("--")) {
        values.flags.set(name, true);
      } else {
        values.flags.set(name, argv[index + 1]);
        index += 1;
      }
    } else {
      values.positionals.push(token);
    }
  }
  return values;
}

function uniqueWarnings(list) {
  return [...new Set(list.map((item) => String(item ?? "").trim()).filter(Boolean))];
}

async function withTimeout(factory, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(factory),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function detectBinaries(env = process.env) {
  // 只报告真实可执行的 Agent；内置 bin/codex 只是 wrapper，不能当作 Codex
  // 已安装，否则二进制缺失时恢复按钮会被错误地启用。
  return {
    claude: detectBinary("claude", { env }),
    codex: detectBinary("codex", { env }),
    hermes: detectBinary("hermes", { env }),
  };
}

export async function runCli(argv = process.argv.slice(2)) {
  const parsed = parseArgs(argv);
  const command = parsed.positionals[0] || "sync";
  const flag = (name) => parsed.flags.get(name);
  const hasFlag = (name) => parsed.flags.has(name);
  const asJson = hasFlag("--json") || !process.stdout.isTTY;
  const env = process.env;
  const home = homedir();
  const claudeHome = flag("--claude-home") || env.CLAUDE_HOME || env.CLAUDE_CONFIG_DIR || join(home, ".claude");
  const codexHome = flag("--codex-home") || env.CODEX_HOME || join(home, ".codex");
  const hermesHome = flag("--hermes-home") || env.HERMES_HOME || join(home, ".hermes");
  const cache = flag("--cache") || cachePath({ home, appHome: env.HERDR_APP_HOME, env });
  const timeoutMs = Math.max(50, Number(flag("--timeout") || env.AGENT_HISTORY_TIMEOUT_MS || 20_000));
  const output = (value) => process.stdout.write(
    `${asJson ? JSON.stringify(value) : JSON.stringify(value, null, 2)}\n`,
  );

  const finishSync = async (value) => {
    try {
      await writeCacheAtomic(cache, value);
    } catch (error) {
      value.warnings = uniqueWarnings([...value.warnings, `Could not write history cache: ${errorMessage(error)}`]);
    }
    output(value);
    return value;
  };

  try {
    if (command === "sync") {
      const previous = await readCache(cache);
      const cwdCache = new Map();
      const results = await Promise.all(AGENTS.map(async (agent) => {
        const tasks = {
          claude: () => readClaudeSessions({ claudeHome }),
          codex: () => readCodexSessions({
            codexHome,
            codex: env.CODEX_BIN || undefined,
            timeoutMs,
          }),
          hermes: () => readHermesSessions({ hermesHome }),
        };
        try {
          const result = await withTimeout(tasks[agent], timeoutMs, AGENT_NAMES[agent]);
          return { agent, ok: true, result };
        } catch (error) {
          return { agent, ok: false, error };
        }
      }));

      const agents = {};
      const directories = [];
      const sessions = [];
      const staleAgents = [];
      const warnings = [];

      for (const item of results) {
        const agent = item.agent;
        const old = previous?.agents?.[agent];
        let entry;
        if (item.ok) {
          const result = item.result || {};
          const view = agentViewFor(agent, result.sessions, {
            available: result.available !== false,
            reason: result.reason || null,
            warnings: result.warnings || [],
            stale: Boolean(result.stale),
            home,
            cwdCache,
          });
          entry = {
            available: view.available,
            reason: view.unavailableReason,
            stale: view.sync.stale,
            warnings: view.sync.warnings,
            sessions: view.sessions,
            directories: view.directories,
            counts: view.counts,
          };
        } else {
          const message = `${AGENT_NAMES[agent]} sync failed: ${errorMessage(item.error)}`;
          if (old) {
            // 单个 Agent 失败：保留该 Agent 上次成功的数据，标记 stale。
            const view = agentViewFor(agent, old.sessions, {
              available: old.available !== false,
              reason: old.reason || null,
              warnings: uniqueWarnings([...(old.warnings || []), message]),
              stale: true,
              home,
              cwdCache,
            });
            entry = {
              available: view.available,
              reason: view.unavailableReason,
              stale: true,
              warnings: view.sync.warnings,
              sessions: view.sessions,
              directories: view.directories,
              counts: view.counts,
            };
          } else {
            const view = buildAgentView(agent, [], {
              available: false,
              reason: "sync failed",
              warnings: [message],
              stale: false,
              home,
            });
            entry = {
              available: false,
              reason: view.unavailableReason,
              stale: false,
              warnings: view.sync.warnings,
              sessions: [],
              directories: [],
              counts: view.counts,
            };
          }
        }
        agents[agent] = entry;
        directories.push(...entry.directories);
        sessions.push(...entry.sessions);
        warnings.push(...entry.warnings);
        if (entry.stale) staleAgents.push(agent);
      }

      const syncedAt = now();
      const binaries = detectBinaries(env);
      const agentStatus = Object.fromEntries(AGENTS.map((agent) => [agent, {
        available: agents[agent].available,
        stale: agents[agent].stale,
        reason: agents[agent].reason || null,
        warnings: agents[agent].warnings,
      }]));
      const value = {
        schemaVersion: 2,
        syncedAt,
        agents,
        directories,
        sessions,
        agentStatus,
        staleAgents,
        warnings: uniqueWarnings(warnings),
        binaries,
      };
      await finishSync(value);
      return value;
    }

    if (command === "status" || command === "reconcile") {
      const previous = await readCache(cache);
      const value = previous || emptyHistory({
        syncedAt: 0,
        warning: command === "status" ? "No successful sync yet" : null,
      });
      output(value);
      return value;
    }

    if (command === "preview") {
      const agent = String(flag("--agent") || "codex").toLowerCase();
      const sessionId = flag("--session") || flag("--thread") || parsed.positionals[1];
      if (!AGENTS.includes(agent)) throw new Error(`Unknown agent: ${agent}`);
      if (!sessionId) throw new Error("preview needs --session <id>");
      const cwd = flag("--cwd") || null;
      const path = flag("--path") || null;
      let transcript;
      if (agent === "claude") transcript = await readClaudePreview({ claudeHome, sessionId, path });
      else if (agent === "hermes") transcript = await readHermesPreview({ hermesHome, sessionId });
      else transcript = await readCodexPreview({ codexHome, sessionId, path });
      const title = flag("--title") || transcript.title || null;
      process.stdout.write(renderTranscript({
        agent,
        title,
        sessionId,
        cwd,
        messages: transcript.messages,
        color: Boolean(process.stdout.isTTY),
      }));
      return null;
    }

    if (command === "launch") {
      const value = { ok: false, error: "Launch is owned by the Herdr Mod so it can create a visible Pane." };
      output(value);
      return value;
    }

    throw new Error(`Unknown command: ${command}`);
  } catch (error) {
    if (command === "preview") {
      process.stderr.write(`agent-history: ${errorMessage(error)}\n`);
    } else {
      output(emptyHistory({
        syncedAt: 0,
        warning: errorMessage(error),
      }));
    }
    process.exitCode = 1;
    return null;
  }
}

const invokedAsScript = process.argv[1]
  ? pathToFileURL(process.argv[1]).href === import.meta.url
  : false;
if (invokedAsScript) await runCli();
