import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const DEFAULT_TIMEOUT_MS = 30_000;
const moduleDir = dirname(fileURLToPath(import.meta.url));
const bundledCodex = [
  join(moduleDir, "..", "bin", "codex"),
  join(moduleDir, "..", "..", "bin", "codex"),
].find(existsSync);
const DEFAULT_CODEX = bundledCodex || "codex";

/** A small newline-delimited JSON-RPC client for `codex app-server --stdio`. */
export class CodexAppServer {
  constructor({ codex = DEFAULT_CODEX, codexHome, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    this.codex = codex;
    this.codexHome = codexHome;
    this.timeoutMs = timeoutMs;
    this.nextId = 1;
    this.pending = new Map();
    this.stderr = "";
    this.started = false;
  }

  start() {
    if (this.started) return;
    this.started = true;
    const env = { ...process.env };
    if (this.codexHome) env.CODEX_HOME = this.codexHome;
    this.child = spawn(this.codex, ["app-server", "--stdio"], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.on("error", (error) => this.fail(error));
    this.child.on("close", (code, signal) => {
      const detail = this.stderr.trim() || `app-server exited (${code ?? "?"}${signal ? `, ${signal}` : ""})`;
      this.fail(new Error(detail));
    });
    const input = readline.createInterface({ input: this.child.stdout });
    input.on("line", (line) => this.handleLine(line));
    this.child.stderr.on("data", (chunk) => {
      this.stderr += String(chunk);
      // Keep an error useful without retaining unbounded plugin/network logs.
      if (this.stderr.length > 16_000) this.stderr = this.stderr.slice(-16_000);
    });
  }

  handleLine(line) {
    if (!line.trim()) return;
    let message;
    try { message = JSON.parse(line); }
    catch { return; }
    if (message.id === undefined || message.id === null) return; // notification
    const pending = this.pending.get(String(message.id));
    if (!pending) return;
    this.pending.delete(String(message.id));
    clearTimeout(pending.timer);
    if (message.error) {
      const error = new Error(message.error.message || "Codex app-server request failed");
      error.code = message.error.code;
      error.data = message.error.data;
      pending.reject(error);
    } else pending.resolve(message.result);
  }

  fail(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  request(method, params = {}) {
    this.start();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(String(id));
        reject(new Error(`Timed out waiting for ${method}`));
        this.close();
      }, this.timeoutMs);
      this.pending.set(String(id), { resolve, reject, timer });
      try {
        this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(String(id));
        reject(error);
      }
    });
  }

  async initialize() {
    return this.request("initialize", {
      clientInfo: { name: "herdr-agent-history-mod", version: "0.2.0" },
      capabilities: { experimentalApi: true },
    });
  }

  async list(method, params = {}) {
    const data = [];
    let cursor = null;
    const seen = new Set();
    do {
      const page = await this.request(method, { ...params, cursor });
      for (const value of page?.data ?? []) data.push(value);
      const next = page?.nextCursor ?? null;
      if (!next || seen.has(next)) break;
      seen.add(next);
      cursor = next;
    } while (true);
    return data;
  }

  close() {
    if (!this.child || this.child.exitCode !== null) return;
    this.child.kill();
  }
}

