#!/usr/bin/env node
// 兼容入口：旧安装路径和 bin/codex-history 仍指向这里。
// 实际实现在 agent-history.mjs，支持 Claude / Codex 两个适配器。
import { runCli } from "./agent-history.mjs";

await runCli();
