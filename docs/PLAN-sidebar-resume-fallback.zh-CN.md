# Agent History 侧栏：恢复策略与展示改造方案

> 状态：**方案，未改代码、未安装、未提交**。  
> 目标：解决 cwd 失效 / 不可访问 / 无 cwd 时侧栏统一显示 `No resume` 的问题，改为“原目录恢复 → 备用目录恢复 → 真正不可用”的分层策略，并让 Herdr 的 space/tab、终端标签、live 匹配使用同一个 `effectiveCwd`。  
> 前提：采用任务书中已实测确认的 Codex 0.166、Claude Code 2.1.318、Hermes 0.22.x 和 Herdr 归属规则，不在本方案中重复验证。

---

## 1. 根因与现状

### 1.1 当前用户看到的错误

侧栏里 cwd 已删除的会话显示为：

```text
总结 mod 功能...   5d   No resume
```

`No resume` 同时覆盖了三种完全不同的情况：

1. 原目录不存在，但 Agent 本身仍可从备用目录恢复；
2. 原目录存在但不可访问；
3. Agent 二进制缺失、会话数据缺失等真正不可用。

用户无法判断能不能恢复、为什么不能恢复、应该去哪里恢复。

### 1.2 根因链

| 位置 | 当前行为 | 影响 |
|---|---|---|
| `mods/herdr-codex-sidebar-mod/launch-target.mjs:58-70` `resumeAvailability` | 只要 `!session.cwd` 或 `cwdKey === NO_CWD_KEY` 就返回 `ok: false` | cwd 失效直接禁用恢复 |
| `mods/herdr-codex-sidebar-mod/view-model.mjs:187-227` `normalizeSession` | `capabilities.resume = ... && !reason`，而 `reason` 来自 cwd 状态 | 数据层提前把会话标成“不可恢复”，UI 只是如实显示 |
| `mods/herdr-codex-sidebar-mod/main.js:544-549` `validatedCwd` | 原 cwd 不存在就 `throw` | `launchSession` 直接失败，没有 fallback 分支 |
| `mods/herdr-codex-sidebar-mod/launch-target.mjs:78-97` `resumeCommand` / `resumeArgv` | Codex 没有 cwd 就抛错；Claude/Hermes 总是 `cd` 原 cwd | 无法生成 fallback 命令 |
| `mods/herdr-codex-sidebar-mod/main.js:362-364` `spaceFor` + `launch-target.mjs:24-51` `findDirectorySpace` | 只按字符串匹配 folder / pane.cwd，不验证目录是否存在 | 会复用 folder 已失效的 space，且 fallback 时仍把原 cwd 传给 `tab.new` / `space.new` |
| `mods/herdr-codex-sidebar-mod/main.js:366-384` `label` | 写入 `session.cwd` | fallback 恢复后终端标签仍是原 cwd，live 匹配会认为恢复失败 |
| `mods/herdr-codex-sidebar-mod/live-state.mjs:151-169,184-210,212-263` | live 匹配用 `session.cwd` 做同目录判断 | fallback 目录与 session.cwd 不同，标签/标题匹配会被错误过滤 |
| `mods/herdr-codex-sidebar-mod/main.js:919-955` `sessionRow` | 所有不可恢复情况统一显示 `No resume` | 不能显示 `Resume in <dir>` / `Unavailable` / `Preview only` |
| `mods/herdr-codex-sidebar-mod/main.js:981-1027` `renderView` | 目录列表是平铺的，missing 目录按活跃度混排在正常目录中 | 失效目录没有折叠、没有明确的末尾位置 |
| `mods/herdr-codex-sidebar-mod/main.js:56-65,74-76` | 只有 agent、目录选择、页码用 `localStorage`，没有 fallback 配置 | 无法记住用户指定的备用目录 |

### 1.3 目标行为

| cwd 状态 | 恢复位置 | 展示 |
|---|---|---|
| 存在且可访问 | 原目录 | 正常，不额外标记 |
| 不存在 / 不可访问 / 无 cwd | 用户配置的备用目录 | `Resume in <dir>`，tooltip 说明原目录和备用目录 |
| 原目录失效且没有可用 fallback | 不启动，先要求用户配置 | `Set fallback` / `Fallback required` |
| 严格模式开启且 cwd 失效 | 只预览，不恢复 | `Preview only` |
| Agent 二进制缺失或会话数据缺失 | 不恢复 | `Unavailable` |

**关键约束：** fallback 不只是改 resume 命令。`spaceFor()`、`tab.new` / `space.new` 的 `folder`、placeholder 的 `cd`、终端标签 `agent.cwd`、live 匹配必须使用同一个 `effectiveCwd`。

---

## 2. 数据模型 / 状态定义

### 2.1 术语

- **originalCwd**：会话记录里的原始 cwd。
- **effectiveCwd**：本次恢复实际使用的目录；可能是 original、fallback、显式 override，也可能为 null。
- **fallback**：用户配置或统计得到的备用目录。
- **cwdInfo**：helper 已经产出的目录状态对象：`{ key, cwd, exists, accessible, status, ... }`。
- **resumeMode**：`original` / `fallback` / `override` / `preview-only` / `fallback-required` / `unavailable`。

### 2.2 `CwdStatus`

沿用并明确现有 helper 的状态：

```ts
type CwdStatus =
  | "ok"
  | "missing-directory"
  | "inaccessible"
  | "missing-cwd"
  | "relative";
```

`ok` 必须同时满足 `exists === true && accessible === true`；其余状态都可以走 fallback，除非严格模式开启。

### 2.3 `Session` 字段调整

保留现有字段，新增/调整语义：

```ts
interface Session {
  // 现有字段
  cwd: string | null;
  cwdKey: string;
  cwdInfo: CwdInfo;
  unavailableReason: string | null;

  capabilities: {
    preview: boolean;
    // 语义调整：表示“会话数据是否支持恢复”，不再因为 cwd 失效而为 false
    resume: boolean;
    // 新增：表示“能否在原 cwd 直接恢复”
    resumeInPlace: boolean;
  };

  // UI 计算字段（不要求 helper 写入缓存）
  effectiveCwd?: string | null;
  effectiveCwdSource?: "original" | "fallback" | "override" | "none";
  resumeMode?: ResumeMode;
  resumeBlockedReason?: string | null;
}
```

`view-model.mjs` 中 `normalizeSession` 的改动：

- `capabilities.resume` 只读 adapter 的显式能力：`value.capabilities?.resume !== false`；
- 不再与 `unavailableReasonForCwd(info)` 相与；
- 保留 `unavailableReason` 用于展示和 fallback 判断；
- 新增 `capabilities.resumeInPlace = !reason`。

这会改变现有测试里“missing cwd => capabilities.resume === false”的断言，需要同步修改为：

```js
assert.equal(missing.capabilities.resume, true);
assert.equal(missing.capabilities.resumeInPlace, false);
```

### 2.4 `EffectiveCwd`

新增纯函数，放在 `launch-target.mjs`，避免 UI 和命令层各算一套：

```ts
interface EffectiveCwd {
  cwd: string | null;
  source: "original" | "fallback" | "override" | "none";
  mode: "original" | "fallback" | "override" | "preview-only" | "fallback-required";
  needsUserInput: boolean;
  reason: string | null;
}
```

建议签名：

```js
resolveEffectiveCwd({
  session,
  fallback,        // { cwd, valid, source } | null
  override,        // { cwd, valid } | null
  strictResume,    // boolean
})
```

判定顺序：

1. `override.valid === true` → `source: "override"`，`mode: "override"`；
2. `cwdInfo.status === "ok" && exists && accessible && session.cwd` → `source: "original"`，`mode: "original"`；
3. `strictResume` 且 cwd 不是 ok → `source: "none"`，`mode: "preview-only"`，`needsUserInput: false`；
4. `fallback.valid === true` → `source: "fallback"`，`mode: "fallback"`；
5. 否则 → `source: "none"`，`mode: "fallback-required"`，`needsUserInput: true`，`reason` 为原目录状态说明。

**注意：** `effectiveCwd` 为 null 不等于 `Unavailable`。真正的 `Unavailable` 只由会话 id 缺失、adapter 明确禁止恢复、Agent 二进制缺失等条件产生。

### 2.5 `ResumeAvailability`

重构 `launch-target.mjs:58-70` 的返回值：

```ts
interface ResumeAvailability {
  ok: boolean;
  mode: "original" | "fallback" | "override" | "preview-only" | "fallback-required" | "unavailable";
  effectiveCwd: string | null;
  needsFallback: boolean;
  reason: string | null;
}
```

判定：

```js
if (!session?.id) return unavailable("Unknown session");
if (!kind) return unavailable("Unknown agent");
if (!binary) return unavailable(`${name} executable not found`);
if (session.capabilities?.resume === false) return unavailable(session.unavailableReason || "Session cannot be resumed");

// strict 模式：原 cwd 无效时只允许预览
if (strictResume && effective.mode === "preview-only") {
  return { ok: false, mode: "preview-only", effectiveCwd: null, needsFallback: false, reason: "Strict mode: preview only" };
}

// 原目录/fallback/override 都没有
if (!effective.cwd) {
  return {
    ok: false,
    mode: "fallback-required",
    effectiveCwd: null,
    needsFallback: true,
    reason: "Fallback directory required",
  };
}

return {
  ok: true,
  mode: effective.mode,
  effectiveCwd: effective.cwd,
  needsFallback: false,
  reason: null,
};
```

`previewAvailability` 不变；预览只依赖会话数据和 `capabilities.preview`，不依赖 cwd 或二进制。

### 2.6 Fallback 配置与持久化

P0 使用 Herdr mod 的 `localStorage`（AGENTS.md 明确说明它是 per-mod 持久状态），不新增 helper 配置文件；这样与现有 `SAVED_AGENT`、目录、页码的持久化方式一致，避免跨 UI/helper 的读写一致性问题。

键名建议：

```js
const FALLBACK_GLOBAL = "herdr-agent-history-fallback-directory";
const fallbackAgentKey = (agent) => `herdr-agent-history-fallback-directory-${agent}`;
const STRICT_RESUME = "herdr-agent-history-strict-resume";
const SESSION_CWD_OVERRIDES = "herdr-agent-history-cwd-overrides";
const MISSING_EXPANDED = (agent) => `herdr-agent-history-missing-expanded-${agent}`;
```

值：

```ts
interface FallbackSettings {
  // 全局用户配置
  fallbackDirectory: string | null;
  // 按 Agent 的用户配置
  agents: {
    claude: { fallbackDirectory: string | null };
    codex: { fallbackDirectory: string | null };
    hermes: { fallbackDirectory: string | null };
  };
  strictResume: boolean;
  // 显式“移动到目录”的本地覆盖；不写 Agent 原始数据
  sessionCwdOverrides: Record<string, { cwd: string; updatedAt: number }>;
}
```

**读取优先级（严格按任务书）：**

1. `user.fallbackDirectory`（全局用户配置，最高）；
2. `agents[kind].fallbackDirectory`（Agent 配置）；
3. 统计默认值（见第 5 节）；
4. 都没有或都无效 → `needsUserInput = true`，强制输入。

高优先级值无效时：

- 不静默使用；记录 warning；
- 继续尝试下一优先级；
- 如果最终没有有效目录，打开 fallback 编辑器，输入框预填“统计默认值 / 最后一个无效值”。

多窗口说明：`localStorage` 是 per-mod 状态，多个窗口不会自动共享；如果后续需要跨窗口共享，再迁移到 `~/.config/herdr-app/data/herdr-agent-history/settings.json`，解析与优先级规则保持不变。

### 2.7 `DirectoryGroup` / `AgentView`

保留现有结构，新增/明确：

```ts
interface DirectoryGroup {
  key: string;
  cwd: string | null;
  displayName: string;
  exists: boolean;
  accessible: boolean;
  missing: boolean;
  inaccessible: boolean;
  sessions: Session[];
  sessionCount: number;
  lastActivityAt: number;
}
```

`AgentView.counts` 仍只有 `total`，不增加全局“已打开 / 执行中”汇总。

排序规则改为：

```text
活跃目录（exists && accessible） 
  → 失效目录（missing-directory / inaccessible）
  → No directory（__no_cwd__）
```

每个分组内部仍按 `lastActivityAt` 倒序；`No directory` 永远独立，不能与 missing 目录合并。

---

## 3. 改动点清单（文件:行，函数级）

> 行号是当前工作区快照；实现时以函数名为准，不要求机械对齐。

### 3.1 `mods/herdr-codex-sidebar-mod/view-model.mjs`

| 位置 | 函数 | 改动 |
|---|---|---|
| `138-157` | `cwdInfoFor` | 保持；确保 fallback/override 使用同一 `cwdInfo` 形状 |
| `176-185` | `unavailableReasonForCwd` | 保留原目录原因，不再作为 `capabilities.resume` 的唯一依据 |
| `187-227` | `normalizeSession` | `capabilities.resume` 去掉 `&& !reason`；新增 `resumeInPlace`；保留 `unavailableReason` |
| `256-308` | `groupDirectories` | 新排序：活跃 → missing/inaccessible → No directory；missing 不并入 No directory |
| `310-342` | `buildAgentView` | 可增加 `fallback`/`warnings` 透传；`counts` 仍只 total |
| 新增 | `computeFallbackDefault(...)` | 统计默认备用目录；纯函数，便于单测 |
| 新增 | `applySessionCwdOverrides(...)` | 应用显式“移动到目录”的本地 override，并重建分组；不写 Agent 原始数据 |
| 新增 | `displayNameForFallback(...)` | 生成 `Resume in <dir>` 的短名称，供 UI 使用 |

### 3.2 `mods/herdr-codex-sidebar-mod/launch-target.mjs`

| 位置 | 函数 | 改动 |
|---|---|---|
| `24-51` | `findDirectorySpace` | 保留兼容签名；新增 `findDirectorySpaceMatches`，返回候选 `{space, folder}`，供 main 做目录存在性筛选 |
| `58-70` | `resumeAvailability` | 接受 `effective`/`fallback`/`strictResume`；cwd 失效不再直接 false |
| 新增 | `resolveEffectiveCwd` | 按 2.4 的优先级计算 original/fallback/override/preview-only/fallback-required |
| `78-87` | `resumeCommand` | 增加 `mode`；Codex fallback 不加 `-C`；Claude 不强制 `cd`；Hermes fallback 加 `--no-restore-cwd` |
| `89-97` | `resumeArgv` | Codex fallback 返回 `[bin, "--no-daemon", "resume", id]`；Hermes fallback 加 `--no-restore-cwd`；Claude 仍 `[bin, "--resume", id]` |
| `99-104` | `resumeShellCommand` | placeholder 路径显式 `cd <effectiveCwd>`（尤其 Codex fallback 没有 `-C` 时必须）；继续写 `agent.resume.exit` |
| `106-131` | `previewShellCommand` | 保持只读、不 cd；不把 fallback 用于预览历史内容 |

**命令矩阵（必须逐项测试）：**

| Agent | 原目录有效 | fallback |
|---|---|---|
| Codex | `codex --no-daemon -C <original> resume <id>` | `codex --no-daemon resume <id>`；placeholder：`cd <fallback> && codex --no-daemon resume <id>` |
| Claude | `claude --resume <id>`；placeholder 需要时 `cd <original> && claude --resume <id>` | `claude --resume <id>`；placeholder：`cd <fallback> && claude --resume <id>` |
| Hermes | `hermes --resume <id>` | `hermes --no-restore-cwd --resume <id>`；placeholder：`cd <fallback> && hermes --no-restore-cwd --resume <id>` |

> Claude 的直接 tab 恢复不依赖 `cd`：`tab.new { folder: effectiveCwd, argv }` 已经决定启动目录。placeholder 是已有 shell，必须显式 `cd` 才能保证命令运行在 `effectiveCwd`。

### 3.3 `mods/herdr-codex-sidebar-mod/live-state.mjs`

| 位置 | 函数 | 改动 |
|---|---|---|
| `102-126` | `agentTerminalLabels` | 调用方传 `effectiveCwd`；标签仍写 `agent.cwd`，但值不再是原 cwd |
| `151-169` | `liveCwdOf` / `cwdCompatible` / `titleCandidates` | `cwdCompatible` 接受 `cwdForSession` 回调；标题候选用 `effectiveCwd` 判断 |
| `184-210` | `inferredByStart` | 用 `cwdForSession(session)` 代替 `session.cwd` |
| `212-263` | `matchLiveSession` | 新增 `cwdForSession` option；标签命中仍优先，fallback 恢复后不能再因为原 cwd 不同而丢匹配 |

### 3.4 `mods/herdr-codex-sidebar-mod/main.js`

| 位置 | 函数/成员 | 改动 |
|---|---|---|
| `40-42` | 常量 | 增加 fallback / strict / override / missing-expanded 的 storage key |
| `67-101` | `init` | 读取 fallback 设置、override、missing 展开状态；新增 `this.fallback`、`this.fallbackEditor`、`this.sessionMenu`、`this.spaceLocks` |
| `171-204` | `refresh` | sync 后计算默认 fallback、验证配置目录（`test -d`）、应用 override；把 fallback warning 合并到 UI 错误 |
| `233-282` | `sessionLive` | 调用 `matchLiveSession(..., { cwdForSession: (s) => this.effectiveCwdFor(s) })` |
| `298-302` | `resumeState` | 改为基于 `resolveEffectiveCwd` + `resumeAvailability`；返回 `Resume in` / `Set fallback` / `Unavailable` / `Preview only` |
| 新增 | `effectiveCwdFor(session)` | 同步读取当前已验证的 fallback/override；渲染和 live 匹配共用 |
| 新增 | `resolveSessionTarget(session, cx)` | 异步重新验证 original/effective 目录；返回 `{effectiveCwd, mode, reason}` |
| `316-360` | `placeholderFor` | 保存 `spaceId`/`cwd` 后仍返回；恢复时需要校验 placeholder space 的 folder 是否等于 `effectiveCwd` |
| `362-364` | `spaceFor` | 改为异步；用 `findDirectorySpaceMatches` + `test -d` 验证候选 space 的 folder；跳过失效 space |
| 新增 | `folderExists(path)` | 本地 `exec("test", ["-d", path])`；失败返回 false |
| 新增 | `withSpaceLock(cwd, fn)` | 同一 cwd 并发恢复时串行查/建 space，避免重复 `space.new` |
| `366-384` | `label` | 增加 `cwd` 参数或读取 session.effectiveCwd；写 `agent.cwd = effectiveCwd` |
| `409-423` | `syncLiveLabels` | 用 `effectiveCwdFor(session)` 更新标签 |
| `481-509` | `openTab` | 预览 tab 使用 `effectiveCwd` 作为 folder；无 fallback 时仍允许无 folder 的只读预览 |
| `511-542` | `resume` | 先 `resolveSessionTarget`；`needsFallback` 时打开 fallback 编辑器并停止；strict 模式转预览；只有真正不可用才提示 |
| `544-549` | `validatedCwd` | 改为 `resolveSessionTarget` 的一部分；原目录失效不再 `throw`，而是进入 fallback / 编辑流程 |
| `551-581` | `launchSession` | 用 `action.effectiveCwd` 生成 argv、space、folder；Codex fallback 走无 `-C` argv；`spaceFor` 异步等待 |
| `583-620` | `watchLaunch` | 匹配 `terminal.cwd === action.effectiveCwd`；标签写入使用 effectiveCwd |
| `622-658` | `createPlaceholder` | `action.cwd` 改为 effectiveCwd；fallback 时在 fallback space 建 preview tab；无 fallback 时允许无 folder 预览 |
| `660-708` | `watchOpen` | 用 `action.effectiveCwd` 匹配新 tab；无 cwd 预览保留唯一 tab 判定 |
| `710-751` | `startPlaceholder` | `resolved.effectiveCwd`；`resumeShellCommand` 带 mode；标签写 fallback；清除旧 placeholder |
| `753-788` | `watchResume` | 通过 `cwdForSession` 匹配；标签写 effectiveCwd；避免“tab 起来了但侧栏认为失败” |
| `865-901` | `agentSwitcher` / `agentMenu` | 可增加 `Fallback…` 入口（可选）；不改变单 Agent 视图 |
| `903-917` | `directoryButton` | missing/inaccessible 标记保留；tooltip 写原 cwd + 状态 |
| `919-955` | `sessionRow` | 替换 `No resume` 单一 badge；新增 `Resume in <dir>` / `Set fallback` / `Unavailable` / `Preview only`；tooltip 写“原目录 X 不存在，将在 Y 恢复” |
| `957-971` | `sessionPager` | 不变；分页仍按 Agent + 目录 |
| `981-1027` | `renderView` | 目录栏拆成活跃目录、`Missing (n)` 折叠区、`No directory`；fallback 编辑器渲染在会话区顶部 |
| 新增 | `openFallbackEditor` / `saveFallback` / `chooseFallbackFolder` | 使用 `InputState` + `Input` + `pickFolder`；保存后重新验证并继续 resume |
| 新增 | `openSessionMenu` / `moveSessionToDirectory` | 显式“移动到目录”；写本地 override，不自动迁移 Agent 原始数据 |

### 3.5 helper / cache

本方案 P0 不新增配置文件；`helper/lib/cache.mjs` 保持 schema 2 和原子写入不变。若后续决定把 fallback 配置迁移到文件，再新增 `helper/lib/settings.mjs`，并复用 `writeCacheAtomic` 的 `0600 + rename + chmod` 逻辑；本次不做。

### 3.6 测试与文档

- `test/launch-target.test.mjs`：新增 fallback 命令矩阵、`resolveEffectiveCwd`、space 候选验证、strict 状态。
- `test/view-model.test.mjs`：新增 fallback 默认值算法、目录排序、`capabilities.resume` 语义、override 分组。
- `test/live-state.test.mjs`：新增 fallback cwd 标签匹配、不因原 cwd 失效丢 live。
- `test/normalize.test.mjs` / `test/contract.test.mjs`：更新 missing/inaccessible 会话的 `capabilities.resume`、`resumeInPlace` 断言。
- `test/directory-view.test.mjs`：新增活跃 → missing → No directory 顺序。
- `docs/PRODUCT.zh-CN.md`：补充 fallback 配置、`Resume in` / `Unavailable` / `Preview only` 状态和显式移动。
- `docs/TEST.zh-CN.md`：增加 `RESUME-FALLBACK-*`、`SPACE-VALID-*`、`LIVE-CWD-*`、`UI-FALLBACK-*` 用例。

---

## 4. UI 状态机与线框

### 4.1 会话状态机

```text
                    ┌──────────────────────────────┐
                    │ 会话 id / Agent 数据是否可用？ │
                    └──────────────┬───────────────┘
                                   │ 否
                                   ▼
                              Unavailable
                                   │ 是
                                   ▼
                    ┌──────────────────────────────┐
                    │ 原 cwd 是否 ok？              │
                    └───────┬──────────────┬───────┘
                            │ 是           │ 否
                            ▼              ▼
                       Direct        ┌──────────────┐
                       (无 badge)    │ strictResume? │
                                     └──┬────────┬──┘
                                        │ 是     │ 否
                                        ▼        ▼
                                  Preview only  fallback 有效？
                                                  │ 是       │ 否
                                                  ▼          ▼
                                            Resume in <dir>  Set fallback
```

优先级：

1. `action` / `failure` / `ambiguous` / `live` / `placeholder` 状态优先于恢复 badge；
2. 没有 live 时显示恢复 badge；
3. `Unavailable` 必须伴随可读的 `reason`；
4. `Set fallback` 不是禁用，双击打开编辑器，单击仍可预览；
5. `Preview only` 只允许单/双击进入历史预览。

### 4.2 目录栏

```text
┌ Directories ───────────────┐
│ herdr-codex-sidebar-mod 7  │  ← 活跃目录，正常显示
│ jinrong 3                  │
│ onlyChat 13                │
│                            │
│ ▸ Missing (2)              │  ← 默认折叠，排在活跃目录之后
│   old-project 4  missing   │  ← 展开后显示；不并入 No directory
│   /tmp/gone 1    no access │
│                            │
│ No directory 2             │  ← 永远独立、最后
└────────────────────────────┘
```

规则：

- 活跃目录：按最近活动倒序；
- missing / inaccessible：折叠在 `Missing (n)` 下，默认折叠；用户选中其中目录时自动展开；
- `No directory`：独立分组，排在所有真实目录之后；
- 目录行只显示目录名 + 当前 Agent 会话数；完整 cwd 放 tooltip；
- missing 行显示 `missing` 或 `no access` 标记；
- 不把 missing 的会话并入 `No directory`，也不改变其原目录名。

### 4.3 会话列表

```text
┌ Sessions ───────────────────────────────┐
│ 总结 mod 功能...       5d   Resume in project │
│ ├ tooltip: 原目录 /old/gone 不存在，将在      │
│ │          /Users/.../project 恢复           │
│ 另一条会话...          1h   Working            │
│ 失效且无 fallback...   2d   Set fallback       │
│ 真的不可用...          3d   Unavailable        │
└────────────────────────────────────────┘
```

- `Resume in <dir>` 的 `<dir>` 使用目录短名，过长截断；tooltip 给出完整原目录和 fallback。
- `Set fallback` 表示需要用户配置，不是不可恢复。
- `Unavailable` 只在二进制缺失、adapter 明确不允许恢复、会话数据缺失时出现。
- 没有全局 `已打开 / 执行中` 汇总条，没有 cwd 路径行。

### 4.4 Fallback 编辑器

在会话区顶部显示阻塞式卡片（不启动新终端）：

```text
┌ Fallback directory required ────────────────┐
│ 原目录 /old/gone 不存在。                    │
│ 备用目录: [ /Users/chenkefan/project      ] │
│           [Choose…]  [ ] Only this Agent    │
│           [ ] Strict: preview only          │
│ [Save and resume] [Preview only] [Cancel]   │
└─────────────────────────────────────────────┘
```

交互：

- `InputState.new({ value: defaultCwd })` 在 `openFallbackEditor` 中创建，不能在 `render` 中创建；
- `Choose…` 调用 `pickFolder({ prompt: "Choose fallback directory" })`；
- `Save and resume` 先 `test -d`，失败则保留卡片并显示错误；
- 保存成功后关闭卡片，重新计算 `effectiveCwd`，继续原来的 `resume(session)`；
- `Preview only` 关闭卡片并 `openTab(session)`；
- `Cancel` 关闭卡片，不启动任何命令；
- “Only this Agent” 勾选时写 per-agent key，否则写 global key；
- 严格模式开关可选，默认关闭；打开后只允许预览。

### 4.5 显式“移动到目录”

- 不自动把 fallback 恢复的会话迁移到新目录。
- 在会话行增加 `⋯` / 右键菜单，提供：
  - `Preview`
  - `Resume`
  - `Move to directory…`
  - `Forget override`（已有 override 时）
- `Move to directory…` 调用 `pickFolder`，验证目录存在后写入 `sessionCwdOverrides[agent:id]`。
- 该动作只改变本 mod 的显示归属和之后的 `effectiveCwd`，**不修改 Claude / Codex / Hermes 的原始会话数据**；如果未来需要真正迁移 Agent 存储，另立方案和备份策略。
- 覆盖值失效时显示 warning 并回退到 original/fallback，不阻塞其他会话。

---

## 5. fallback 目录选择算法

### 5.1 输入

- 所有 Agent 的 `sessions`（排除 hidden；是否排除 subagent 建议排除，避免子代理临时目录污染统计）；
- 每条会话的 `cwd`、`cwdInfo.status`、`lastActivityAt`；
- 用户配置的 global / per-agent fallback；
- 显式 session override。

### 5.2 统计默认值

纯函数 `computeFallbackDefault(views, { home })`：

1. 收集所有绝对、非空、非 `NO_CWD_KEY` 的 cwd；
2. 按 `cwdKey` 去重，保留每条的 `lastActivityAt`；
3. `existing = cwdInfo.status === "ok" && exists && accessible` 的目录；
4. 若 `existing` 非空：
   - 求最长公共父目录（LCA）；
   - LCA 不是 `/` 且存在 → 候选 `{ cwd: lca, source: "common-parent" }`；
   - 否则进入第 5 步；
5. 按“出现次数”排序 `existing`：
   - 次数降序；
   - 最近活动降序；
   - 路径字典序升序；
   - 取第一个 `{ cwd, source: "most-frequent" }`；
6. 若没有 existing，但有历史 cwd：取出现次数最高的缺失路径作为“建议值”，但标记 `valid: false`，让 UI 预填并强制用户修改；
7. 若完全没有 cwd → `{ cwd: null, candidates: [], valid: false }`。

默认值必须经过 `test -d` 验证；统计层用 `cwdInfo` 的 stat 结果，UI 保存/恢复前再验证一次。

### 5.3 配置解析与优先级

```js
function resolveFallback(settings, kind, defaultInfo) {
  const ordered = [
    { source: "user", value: settings.fallbackDirectory },
    { source: "agent", value: settings.agents?.[kind]?.fallbackDirectory },
    { source: "default", value: defaultInfo?.cwd },
  ];

  const warnings = [];
  for (const item of ordered) {
    const normalized = normalizeFallbackValue(item.value);
    if (!normalized.ok) {
      if (item.value) warnings.push(`${item.source} fallback is invalid: ${normalized.reason}`);
      continue;
    }
    if (!exists(normalized.cwd)) {
      warnings.push(`${item.source} fallback does not exist: ${normalized.cwd}`);
      continue;
    }
    return {
      cwd: normalized.cwd,
      source: item.source,
      valid: true,
      needsUserInput: false,
      warnings,
    };
  }

  return {
    cwd: null,
    source: null,
    valid: false,
    needsUserInput: true,
    candidates: [defaultInfo?.cwd, settings.fallbackDirectory, settings.agents?.[kind]?.fallbackDirectory]
      .filter(Boolean),
    warnings,
  };
}
```

### 5.4 保存与验证

- 只接受绝对路径；拒绝相对路径、空值、`No directory`；
- `test -d <path>` 失败 → 不可保存；输入框保留原值并显示错误；
- 保存后清除该目录的验证缓存，下一次恢复重新验证；
- 目录在配置后被删除 → 下次恢复重新进入编辑器，不静默使用；
- 保存 `Only this Agent` 时写 `fallbackAgentKey(agent)`，否则写 `FALLBACK_GLOBAL`；
- `strictResume` 单独布尔值。

### 5.5 默认值示例

已知会话 cwd：

```text
/Users/chenkefan/project/app
/Users/chenkefan/project/api
/Users/chenkefan/project/docs
/Users/chenkefan/other
```

LCA = `/Users/chenkefan/project`，存在 → 默认 fallback 为 `/Users/chenkefan/project`。

如果所有 cwd 都缺失，则：

- 出现最多的缺失路径作为预填建议；
- 标记 `valid: false`；
- 打开编辑器，要求用户选择真实目录。

---

## 6. 边界情况

### 6.1 多 Agent

- fallback 配置按 Agent 解析；一个 Agent 的配置不影响其他 Agent；
- 目录分组、选中目录、页码仍按 Agent 独立；
- 默认值统计可以跨 Agent，但 per-agent 配置优先于统计默认值；
- 不得把三个 Agent 的会话混排。

### 6.2 多 space

- `spaceFor(effectiveCwd)` 只复用：
  - `space.folder` 字符串等于 effectiveCwd；
  - 且该 folder 通过 `test -d`；
  - 或 space.folder 为空但匹配 pane 的 cwd 等于 effectiveCwd，且该 cwd 通过验证；
  - 且 `space.machine == null`（本地）。
- **不复用** folder 已失效的 space；
- 没有可用 space 时用 `space.new({ folder: effectiveCwd })`，不能把原失效 cwd 写进去；
- 同名目录多个 space：按 id 字典序确定性选择，避免每次恢复切换不同 space；
- 并发恢复同一 fallback：
  - `this.spaceLocks` 按 effectiveCwd 串行化“查 space → 可能创建 → 等待 spaces() 出现”；
  - 第二次恢复等待第一次完成后重新查询，避免创建两个同名 space；
  - `space.new` 没有同步返回 id 时，用 `cx.timer.after` 轮询 `spaces()`，最多约 1 秒，超时则报 warning。

### 6.3 Placeholder / preview 路径

- 预览只读，不需要 cwd；`previewShellCommand` 继续不 `cd`。
- preview tab 本身创建在 `effectiveCwd`（有 fallback 时）或当前可用目录（无 fallback 时）。
- 双击预览 tab 恢复：
  - 如果 placeholder 所在 space 的 folder 与 effectiveCwd 一致且有效 → 复用 placeholder，`cd effectiveCwd` 后 resume；
  - 如果 placeholder 在失效 space 或不同目录 → 不复用该 placeholder，走 `launchSession` 在 fallback space 新建 tab；原 preview tab 保留，不自动关闭；
  - 不能让 `startPlaceholder` 在失效 space 里直接执行命令。
- 恢复后写 `agent.placeholder=false`，退出时写 `agent.resume.exit`。

### 6.4 并发恢复

- 同一 session 仍由 `actions[session.key]` 防止重复启动；
- 不同 session 可以并行；
- `watchLaunch` / `watchOpen` 用 `beforeTabs` / `beforeTerminals` 快照，避免把用户已有 tab 误认成新 tab；
- fallback 编辑器打开时，再次双击同一 session 不重复启动；
- 保存 fallback 后只恢复当前 session，不批量恢复其他会话。

### 6.5 目录状态变化

- 原目录从存在变为缺失：下一次 `refresh` 的 `cwdInfo` 更新，badge 从 Direct 变 `Resume in`；
- fallback 目录被删除：配置仍保留但 `valid=false`，恢复时重新提示；
- 目录可读但不可访问：按 `inaccessible` 处理，尝试 fallback；
- 相对路径 / 空 cwd：直接归入 `No directory`，只能使用 fallback；
- 旧缓存 stale：保留旧 `cwdInfo` 时，恢复前必须重新 `test -d`，不能信任 stale 状态。

### 6.6 安全

- fallback 必须是绝对路径；拒绝 `..` 归一化后的非绝对结果；
- 所有 shell 参数继续使用 `shellQuote`；
- 不在日志/文档中写入用户真实会话内容；
- 测试只用临时目录和临时 `*_HOME`，不修改真实 Claude/Codex/Hermes 数据；
- 不自动迁移 Agent 原始数据；显式 move 只写本地 override。

### 6.7 性能

- 默认 fallback 每次 sync 计算一次 O(n)，不是每次 render；
- fallback 目录验证按唯一路径缓存，一次 refresh 不重复 stat；
- space 验证只在恢复动作时做，不在 render 中做；
- 目录分组仍是 O(n log n)。

---

## 7. 可执行验收清单

### 7.1 单元测试

- [ ] `resumeAvailability`：cwd 有效 + binary 存在 → `ok, mode: original`。
- [ ] `resumeAvailability`：cwd 失效 + fallback 有效 → `ok, mode: fallback`，不再返回 `No resume`。
- [ ] `resumeAvailability`：cwd 失效 + 无 fallback → `mode: fallback-required, needsFallback: true`。
- [ ] `resumeAvailability`：binary 缺失 → `mode: unavailable`。
- [ ] `resumeAvailability`：`capabilities.resume === false` → `mode: unavailable`。
- [ ] `resumeAvailability`：严格模式 + cwd 失效 → `mode: preview-only`。
- [ ] `resolveEffectiveCwd`：original / fallback / override / preview-only / fallback-required 五条分支。
- [ ] `resumeArgv`：Codex 原目录包含 `-C`；Codex fallback **不包含** `-C`；Claude 仍只有 `--resume`；Hermes fallback 包含 `--no-restore-cwd`。
- [ ] `resumeCommand`：路径含空格、单引号、`$()`、反引号时正确 quoting。
- [ ] `resumeShellCommand`：fallback placeholder 包含 `cd <effectiveCwd>`；仍写 `agent.resume.exit`。
- [ ] `findDirectorySpaceMatches`：返回所有精确匹配候选；`spaceFor` 跳过 folder 不存在的 space。
- [ ] 同名目录多个 space：按 id 确定性选择。
- [ ] `computeFallbackDefault`：公共父目录、出现最多目录、tie-break、无 existing、全部缺失。
- [ ] `normalizeSession`：missing/inaccessible 时 `capabilities.resume === true` 且 `resumeInPlace === false`。
- [ ] `groupDirectories`：活跃 → missing/inaccessible → No directory；missing 不并入 No directory。
- [ ] `matchLiveSession`：fallback 恢复后 `agent.cwd=effectiveCwd` 能命中；原 cwd 失效不影响标签匹配。
- [ ] `sessionCwdOverrides`：显式 override 后分组改变；override 失效时回退。
- [ ] `settings` localStorage 读取优先级：user > agent > default；无效值跳过并产生 warning。

### 7.2 集成 / 静态检查

- [ ] `npm test` 全绿。
- [ ] `herdr-app check mods/herdr-codex-sidebar-mod` passed。
- [ ] `node --check` 所有改动的 `.mjs` / `main.js`。
- [ ] 安装目录与仓库代码一致后再次 `herdr-app check` passed。
- [ ] 用临时 `CLAUDE_HOME` / `CODEX_HOME` / `HERMES_HOME` 跑 sync，不触碰真实数据。
- [ ] 临时缓存权限仍为 `0600`，schema 2 不变。

### 7.3 真实 GUI 手工验收

- [ ] 原目录有效：双击恢复仍在原目录；space/folder 正确；标签 `agent.cwd` 是原目录。
- [ ] 原目录删除：目录行显示 `missing`，会话 badge 显示 `Resume in <dir>`；双击后在 fallback space 启动。
- [ ] fallback space 不存在：自动新建，folder 是 fallback，不是原失效 cwd。
- [ ] fallback space 已存在：复用同一个 space，不重复新建。
- [ ] 无 fallback 配置：双击出现编辑器，输入框预填统计默认值；未保存前不启动命令。
- [ ] 默认值不存在：编辑器显示错误，必须选择真实目录；保存后继续恢复。
- [ ] 保存 `Only this Agent`：只影响该 Agent；其他 Agent 仍用自己的配置。
- [ ] 无 cwd 会话：归入 `No directory`，仍可通过 fallback 恢复。
- [ ] 不可访问目录：显示 `no access`，走 fallback，不误报 `Unavailable`。
- [ ] 二进制缺失：显示 `Unavailable`，不能恢复；预览仍可用。
- [ ] 严格模式：cwd 失效显示 `Preview only`，双击只预览。
- [ ] 通过预览 tab 恢复：fallback 时命令在 fallback 目录执行；标签 cwd 为 fallback。
- [ ] 恢复后侧栏 live 状态为 Working/Idle，不出现“tab 起来了但显示恢复失败”。
- [ ] 同时恢复两个 fallback 到同一目录：只创建一个 space，不互相覆盖。
- [ ] 显式 `Move to directory…`：只改本地归属，不改 Agent 原始数据；重启后仍生效。
- [ ] 三个 Agent 仍单视图切换，不混排；没有全局汇总条和 cwd 路径行。
- [ ] missing 目录默认折叠，选中时展开；`No directory` 独立且最后。

### 7.4 安全 / 回归

- [ ] fallback 只能是本地绝对目录；相对路径和空值被拒绝。
- [ ] `shellQuote` 覆盖所有新参数，无命令注入。
- [ ] 不写 Claude/Codex/Hermes 真实存储。
- [ ] 旧缓存 / stale 数据不会让恢复直接使用未验证目录。
- [ ] 现有安装、Agent 切换、分页、预览、标签测试不回归。

### 7.5 完成定义

满足以下全部条件才算完成：

1. `Resume in <dir>`、`Set fallback`、`Unavailable`、`Preview only` 四种状态可从代码和 UI 明确区分；
2. Codex fallback 的命令确实不带 `-C`；
3. `effectiveCwd` 同时用于 space、folder、argv/cd、标签、live 匹配；
4. 失效 space 不被复用，fallback space 不存在时新建；
5. fallback 默认值算法有单测，且无效默认值会强制输入；
6. missing 目录折叠保留、排在末尾，`No directory` 独立；
7. `npm test`、`herdr-app check`、临时数据 sync 全部通过；
8. 未提交、未修改真实用户会话数据。

---

## 8. 实施顺序建议

1. **纯函数与测试**：`view-model` 的 fallback 统计、排序、capabilities 语义；`launch-target` 的 `resolveEffectiveCwd`、命令矩阵、space 候选。
2. **live 匹配与标签**：`live-state` 接受 `cwdForSession`；`main.label` 写 effectiveCwd。
3. **启动链路**：`main.resume` / `launchSession` / `spaceFor` / placeholder 全部切到 effectiveCwd；先保证 direct fallback 恢复。
4. **UI 状态**：badge 拆分、missing 折叠、fallback 编辑器。
5. **显式移动**：session menu + override。
6. **回归与安装验收**：测试、`herdr-app check`、真实 GUI 手工验收。

---

## 9. 交给执行窗口的硬性约束

- 只实现本方案，不扩大为搜索/归档/目录树等 P1 功能。
- 不修改真实 `~/.claude`、`~/.codex`、`~/.hermes` 数据；测试用临时目录。
- 不 commit、不 push；保留工作区已有未提交改动。
- 完成后必须报告：
  - 改动文件清单；
  - `npm test` 和 `herdr-app check` 的真实输出；
  - 未验证项 / 已知风险；
  - 安装目录是否已更新（若用户要求安装）。
