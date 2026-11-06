# Herdr Agent 历史侧栏 Mod 产品功能文档

| 项目 | 内容 |
|---|---|
| 文档版本 | v0.2 |
| 日期 | 2026-11-04 |
| 状态 | 目标行为规格（Draft，待评审） |
| 适用版本 | 0.2.x |
| 配套文档 | [测试文档](TEST.zh-CN.md) |

> 本文定义**目标行为**，不是当前代码的逐行说明。当前实现仍是 Codex-only + 项目归属模式；差距集中在第 14 节。
>
> 本版的核心变更：**会话列表按 Agent 分区，每个 Agent 内再按真实 cwd 分组；不同 Agent 不在同一列表混排，通过顶部切换器选择要看哪个 Agent。** 不再按 Codex 项目/assignment 分组。

---

## 1. 产品定位

**一句话：把本机 Claude Code、Codex、Hermes 的历史会话按 Agent 分区、在每个 Agent 内按真实工作目录聚合，成为 Herdr 中定位、预览和继续工作的入口。**

它解决的是这条链路：

1. 我记得在某个目录做过一条对话；
2. 我先选 Claude / Codex / Hermes，再看这个 Agent 在该目录下的会话；不同 Agent 不混在一起；
3. 我要知道它现在是否已经打开、是否在运行、是否在等我；
4. 我要么预览历史，要么回到原来的 tab 继续；
5. 整个过程不能重复启动 Agent，也不能破坏原来的 shell 工作现场。

### 产品原则

| 原则 | 含义 |
|---|---|
| cwd 是唯一分组主键 | 目录就是目录；不把 Codex project、Claude 编码目录名或 Hermes project 当作分组依据 |
| 历史与运行分离 | 历史会话是持久事实；终端、tab、Agent 状态是运行事实 |
| Agent 适配器隔离 | Claude、Codex、Hermes 各自读取、解析、恢复；核心层只认统一 Session 模型 |
| 事实优先于推断 | 能读到 cwd、session id、Agent 状态就直接使用；推断必须可失效、可纠正 |
| 不重复启动 | 同一会话已有运行实例时，默认定位而不是再起一个 |
| 不猜目录 | cwd 缺失或目录不存在时不静默回退到 home；宁可禁用恢复并说明原因 |
| 本机只读 | 只读本机历史；不写 transcript、不创建/删除/归档会话 |
| 可降级 | 某一个 Agent 失败时，其他 Agent 和旧缓存仍可用 |

### 非目标（v0.2 明确不做）

- 替代 Claude Code、Codex、Hermes 的聊天界面。
- 恢复 Codex Desktop 的 project / assignment 分组。
- 创建、删除、归档、批量移动历史会话。
- 修改 transcript、伪造 Agent 状态或接管终端画面。
- 在 mod 内维护第二套会话数据库。
- 读取其他机器的历史（Herdr 跨机器能力仍可用于终端和 space）。
- 在终端里注入命令来“修复”Agent 的当前状态。
- P0 不做目录树；每个真实 cwd 是独立分组。

---

## 2. 用户与核心任务

### 目标用户

- 在 Herdr 中长期使用 Claude Code、Codex、Hermes，同时开多个目录/space 的开发者。
- 经常需要回到昨天/上周某个目录下的会话继续工作的人。
- 同一目录下混用多个 Agent，希望按 Agent 分开查看、快速判断“这个 Agent 谁在跑、谁在等我”的人。

### 核心任务

| 编号 | 用户任务 | 成功标准 |
|---|---|---|
| T1 | 按目录找到会话 | 目录列表按最近活动排序，显示真实 cwd |
| T2 | 按 Agent 查看目录 | 顶部选择 Claude/Codex/Hermes 后，右侧只显示该 Agent 的目录与会话 |
| T3 | 快速确认会话内容 | 单击看到只读历史预览，不启动 Agent |
| T4 | 继续会话 | 双击在正确 cwd 恢复正确 Agent 的会话 |
| T5 | 回到已打开会话 | 定位已有 tab/pane，不重复启动 |
| T6 | 判断运行状态 | 区分执行中、需要处理、完成未查看、等待输入、已退出 |
| T7 | 切换 Agent | 三个 Agent 独立视图；没有 All，不混排 |
| T8 | 保留工作现场 | Agent 退出后，预览/占位 tab 仍可复用；`finished` 终端不强行复用 |

---

## 3. 信息架构

```text
┌────────────────────────────────────────────────────────────┐
│ Agent History                        Claude 26 ▾    Refresh│
├──────────────────┬─────────────────────────────────────────┤
│ 目录列表          │                                         │
│                  │ 标题 A                        2m  Working│
│ onlyChat     26  │ 标题 B                       19h         │
│ herdr-mod     6  │ 标题 C                        1d         │
│ jinrong       2  │ ...                                     │
│ No directory  1  │                                         │
└──────────────────┴─────────────────────────────────────────┘

点击右上角 `Claude 26 ▾` 展开：

┌──────────────┐
│ ✓ Claude 26  │
│   Codex 12   │
│   Hermes 2   │
└──────────────┘
```

> 右上角是一个 Agent 切换按钮，显示当前 Agent 和会话数；展开后三选一。右侧列表只显示当前 Agent 的会话。切换 Agent 后，目录、会话、计数和空状态整体切换，不会把三个 Agent 混在同一列表。

### 区域职责

| 区域 | 内容 | 说明 |
|---|---|---|
| 标题栏 | 产品名、Agent 切换器、刷新 | 不显示全局“已打开/执行中”汇总 |
| Agent 切换器 | 一个按钮，显示当前 Agent + 会话数；展开后 Claude / Codex / Hermes 三选一 | 默认记住上次选择；没有 All |
| 目录栏 | 当前 Agent 的目录名、会话总数 | 不常驻显示完整 cwd；选择目录不切换 Herdr 焦点 |
| 会话列表 | 标题、最近时间、状态、分页 | 只含当前 Agent；不显示目录路径行；不需要逐行 Agent 徽标 |
| 无目录分组 | `No directory` | 当前 Agent 中 cwd 缺失/为空的会话；可预览，可通过 fallback 目录恢复 |
| 状态区 | 运行/完成/等待/预览/错误 | 只表达与当前会话关联的事实 |

### 选择与焦点

- **Agent 选择**：`Claude` / `Codex` / `Hermes` 三选一；没有 `All`；默认恢复上次选择，没有记录时按 Claude → Codex → Hermes 选择第一个可用的。
- **目录选择**：按 Agent 分别记住上次选中的 cwd；刷新后尽量保留。
- **会话行高亮**：表示“这条会话有已知的打开实例或预览”，不是“当前 Herdr 焦点”。
- **Herdr 焦点**：由 Herdr 的 space/tab/pane 决定，不能与 Agent 或目录选择混为一谈。

---

## 4. 核心数据模型

```text
AgentView {
  agent: "claude" | "codex" | "hermes"
  available: boolean
  sync: { status, stale, warnings }
  directories: DirectoryGroup[]
  selectedDirectoryKey: string | null
  selectedPage: number
  counts: { total }       // 只用于切换器/目录计数
}

DirectoryGroup {
  agent: "claude" | "codex" | "hermes"
  key: string            // 规范化 cwd，或 "__no_cwd__"
  cwd: string | null
  displayName: string    // 目录名；根目录为 "/"
  exists: boolean
  sessions: Session[]    // 只包含同一个 Agent 的会话
  lastActivityAt: number
}

Session {
  key: string            // `${agent}:${id}`
  agent: "claude" | "codex" | "hermes"
  id: string
  title: string
  preview: string
  cwd: string | null
  createdAt: number
  updatedAt: number
  lastActivityAt: number
  archived: boolean
  hidden: boolean
  subagent: boolean
  parentId: string | null
  capabilities: {
    preview: boolean,
    resume: boolean,        // 会话数据本身是否可恢复（与 cwd 状态无关）
    resumeInPlace: boolean  // 能否直接在原 cwd 恢复
  }
  unavailableReason: string | null
  live?: LiveInfo
}
```

### 4.0 视图分区

- 同步结果仍是统一的 `Session[]`，但 UI 一次只渲染一个 `AgentView`。
- 每个 `DirectoryGroup` 只属于一个 Agent；同一 cwd 可以在三个 AgentView 中各有一组，但不会合并成一个混合列表。
- `AgentView.counts.total` 只用于切换器和目录计数；不显示“已打开/执行中”全局汇总。
- 每个 AgentView 独立保存目录选择和分页；切换 Agent 不覆盖另一个 Agent 的状态。

### 4.1 目录 key 规范化

按以下顺序生成 `cwdKey`：

1. 去掉首尾空白。
2. 反斜杠转 `/`。
3. 展开开头的 `~`。
4. 合并重复 `/`，去掉尾部 `/`（根目录 `/` 除外）。
5. 路径存在时用 `realpath` 解析 symlink；解析失败时保留规范化后的字面路径。
6. Unicode 统一为 NFC。
7. **不转小写**；Linux 区分大小写，macOS 由 realpath 处理大小写/链接。
8. 相对路径不猜测，按“无有效 cwd”处理。
9. `null`、空字符串、相对路径 → `__no_cwd__`。

### 4.2 显示规则

- 目录名取路径最后一段；根目录显示 `/`。
- **不常驻显示完整 cwd，也不在会话列表上方显示路径行。**
- 同名目录冲突时，才显示最短可区分的父级后缀（如 `work/app`、`tmp/app`），或通过 tooltip 查看完整路径。
- 目录不存在时显示 `missing` 标记；仍保留会话，可通过 fallback 目录恢复。
- 目录没有权限访问时显示 `no access`；预览可读历史，恢复走 fallback。
- `No directory` 固定排在最后；只有存在无 cwd 会话时显示，不并入 missing 分组。

### 4.3 排序

- 目录：活跃目录 → missing / inaccessible 目录 → `No directory`；同层内按 `lastActivityAt` 倒序 → 路径字典序。missing 目录默认折叠在 `Missing (n)` 下。
- 会话：在当前 AgentView 内按 `lastActivityAt` 倒序 → `updatedAt` 倒序 → 标题字典序。
- P1：pinned 会话在目录内置顶；目录仍按最近活动排序。

### 4.4 去重

- 会话身份是 `agent:id`；不同 Agent 的相同 id 不合并。
- 同一 Agent 同一 id 出现多条时，取 `lastActivityAt` 更新、字段更完整的一条。
- Claude Code 只读取 `projects/<encoded>/<session-id>.jsonl` 顶层文件；`subagents/` 下的文件不算独立会话。
- Codex 以 app-server 返回的 thread id 为准；重复 id 去重。
- Hermes 以 `sessions.id` 为准；压缩产生的 lineage 由适配器投影到同一逻辑会话。

### 4.5 默认过滤

| 类型 | 默认 | 说明 |
|---|---|---|
| Agent 范围 | 单选 | 一次只显示 Claude / Codex / Hermes 中的一个；没有 All |
| `archived` | 隐藏 | P1 提供“显示归档”开关 |
| `hidden`（Hermes） | 隐藏 | onboarding/Bot Chat 等内部会话 |
| `subagent` | 隐藏 | Claude 子代理、Codex guardian/subagent、Hermes 子会话 |
| 无 cwd | 显示 | 进入 `No directory`，可通过 fallback 恢复 |
| 目录不存在 | 显示 | 标记 missing，可通过 fallback 恢复 |
| 空目录 | 不显示 | 目录分组只由会话产生 |

### 4.6 恢复目录与 fallback

原目录不可用时不再统一显示 `No resume`，而是按以下状态区分：

| 状态 | 含义 | 行为 |
|---|---|---|
| 无徽标 | 原目录存在且可访问 | 双击在原目录恢复 |
| `Resume in <dir>` | 原目录失效，使用配置的备用目录 | 双击在 `<dir>` 恢复；tooltip 说明原目录与原因 |
| `Set fallback` | 原目录失效且没有有效备用目录 | 双击打开 fallback 编辑器，保存前不启动命令 |
| `Preview only` | 严格模式开启且原目录失效 | 双击只进入历史预览 |
| `Unavailable` | Agent 二进制或会话数据不可用 | 不恢复，只保留预览 |

规则：

- `effectiveCwd` 同时用于 space 选择/创建、`tab.new` / `space.new` 的 folder、placeholder 的 `cd`、终端标签 `agent.cwd` 和 live 匹配。
- fallback 配置优先级：全局配置 → 当前 Agent 配置 → 统计默认值（现存目录的公共父目录，其次出现最多的目录）。
- Codex 在 fallback/override 恢复时不带 `-C`，由 tab 的 folder 决定目录；Hermes 使用 `--no-restore-cwd`。
- 目录在恢复前用 `test -d` 重新验证；失效的 space 不复用，必要时新建。
- 显式 `Move to directory…` 只写本 mod 的本地 override，改变分组和后续恢复目录，不修改 Agent 原始会话数据。

---

## 5. 功能范围

优先级：P0 = 可用性门槛；P1 = 稳定性与体验；P2 = 后续能力。

### P0：按 Agent + 目录浏览与恢复主链路

| 编号 | 功能 | 期望行为 |
|---|---|---|
| F-01 | 统一同步 | 并行读取 Claude Code、Codex、Hermes；单个失败不影响其他 Agent |
| F-02 | cwd 分组 | 在每个 Agent 视图内按真实 cwd 聚合；不同 Agent 不混排 |
| F-03 | Agent 切换 | 顶部一个切换按钮，展开 Claude/Codex/Hermes 三选一；没有 All；切换后只显示该 Agent |
| F-04 | 会话列表 | 标题、相对时间、状态、分页；只含当前 Agent；空目录明确空状态 |
| F-05 | 单击预览 | 只读 transcript，不启动 Agent |
| F-06 | 双击恢复 | 在正确 cwd 恢复正确 Agent 的会话 |
| F-07 | 状态显示 | working/blocked/done/idle/unknown；历史会话不冒充运行状态 |
| F-08 | 去重与定位 | 已有实例时定位，不重复启动 |
| F-09 | 部分失败降级 | 一个适配器失败时保留旧缓存和其他 Agent 数据 |
| F-10 | 缓存 | 原子写入、权限 0600、schema 校验；旧缓存可重建 |
| F-11 | 无 cwd/缺目录 | 进入 `No directory` 或标记 missing；恢复禁用并说明原因 |
| F-12 | 标签 | 通用 `agent.*` 标签；兼容读取旧 `codex.*` 标签 |

### P1：稳定性与体验

| 编号 | 功能 | 期望行为 |
|---|---|---|
| F-13 | 分页 | 每个 Agent 的每个目录独立页码，默认 12 条；页码自动收敛 |
| F-14 | 归档/子代理开关 | 默认隐藏；可临时显示并明确标记 |
| F-15 | 搜索 | 按标题、cwd、session id 搜索 |
| F-16 | 目录树 | 可选按父目录聚合显示；默认仍是平铺真实 cwd |
| F-17 | 多实例处理 | 同一会话多个终端时展示实例，不自动选择 |
| F-18 | tab 标题同步 | 跟随会话标题；用户手动改名后停止覆盖 |
| F-19 | 热重载恢复 | 从 Herdr 事实和标签重建状态 |
| F-20 | 窄侧栏/长路径适配 | 中间省略完整路径；不横向溢出 |

### P2：后续能力

| 编号 | 功能 | 说明 |
|---|---|---|
| F-21 | 新建会话 | 从当前目录新建 Claude/Codex/Hermes 会话 |
| F-22 | 归档/取消归档 | 需要各 Agent 的写接口确认 |
| F-23 | 键盘导航 | 上下选择、回车打开、Esc 返回 |
| F-24 | 右键菜单 | 复制 id、打开目录、关闭实例 |
| F-25 | 跨机器历史 | 读取远端 Agent 数据，需独立权限与性能设计 |

---

## 6. 交互规则

### 6.1 单击与双击

| 当前情况 | 单击 | 双击 |
|---|---|---|
| 只有历史记录 | 创建/复用 tab 并预览 | 创建/复用 tab 并恢复 |
| 已有预览 tab | 聚焦原 tab | 在原 tab 恢复 |
| 正在打开/预览/恢复 | 复用进行中的操作 | 记录一次恢复意图 |
| 已有运行实例 | 聚焦已有会话 | 聚焦已有会话 |
| Agent `working/blocked/done/idle` | 聚焦已有会话 | 聚焦已有会话 |
| Agent 存活但无 Pane | 尝试挂回 | 复用已有终端，不新起 |
| 已退出，预览/占位 shell 存活 | 聚焦该 tab | 在该 tab 中恢复 |
| 终端 `finished` | 新建 tab 预览 | 新建 tab 恢复 |
| 原终端被其他程序占用 | 聚焦原终端 | 提示并允许新开 |
| 同会话多实例 | 展示实例供选择 | 不凭猜测启动 |
| 关联不确定 | 显示“待确认” | 不自动启动 |
| cwd 缺失/不存在/无权限 | 预览可用 | 恢复禁用，说明原因 |

约束：

- 双击不能因为第一次单击已触发预览而创建两个 tab。
- 快速连续双击/多次点击只能产生一个恢复动作。
- 恢复进行中，重复点击不叠加命令。

### 6.2 目录选择

- 点击目录只改变右侧列表，不切换 Herdr space/tab。
- 默认恢复上次选中的 cwd；不存在时回退到第一个目录。
- 没有目录但有 `No directory` 时，展示 `No directory`。
- 同步结果为空且没有历史时，不立即清除保存的选择（可能只是临时失败）。

### 6.3 Agent 切换

- 顶部只有一个 Agent 切换按钮，显示当前 Agent + 会话数；点击展开 `Claude` / `Codex` / `Hermes` 三选一，没有 `All`。
- 选中项用背景/勾选/边框等非颜色单一手段标明；不可用项禁用并给原因。
- 会话列表不显示目录路径行；当前 Agent 由切换按钮标明，当前目录由左侧选中项标明。
- 切换后，目录栏、会话栏、空状态全部切到该 Agent。
- 每个 Agent 分别记住自己的目录选择和页码；来回切换不互相覆盖。
- 当前 Agent 未安装/无数据时，按钮仍显示但禁用，或显示“无数据”并说明原因；不能把其他 Agent 的会话拿来填充。
- 当前 Agent 刷新失败时，保留该 Agent 的旧缓存并标记 stale；不自动切到其他 Agent。
- 切换 Agent 不改变会话身份、不触发预览/恢复、不切换 Herdr 焦点。
- 会话列表里不再重复显示 Agent 徽标；当前 Agent 只在切换按钮中标明。

### 6.4 刷新

| 触发 | 行为 |
|---|---|
| 手动 Refresh | 立即同步；同步中显示加载态；重复点击不并发 |
| 60 秒定时 | 后台同步，不阻塞 UI |
| Agent 标题变化 | 相关 Agent 尽快刷新 |
| 最近 10 分钟有未匹配的 Agent | 最多每 15 秒触发一次刷新 |
| 单个 Agent 失败 | 保留该 Agent 旧缓存；其他 Agent 正常更新；显示 warning |

### 6.5 分页

- 默认每页 12 条。
- 页码按 Agent + 目录保存；切换 Agent 或目录后恢复。
- 列表变短时当前页自动收敛。
- 分页只影响渲染，不影响排序。

### 6.6 明确不支持的交互

v0.2 不提供：右键菜单、搜索、新建、归档、批量操作、拖拽排序、目录改名。未实现前 UI 不出现可点击但无效果的入口。

---

## 7. cwd 分组规则

### 7.1 分组

- **在每个 Agent 视图内，只按会话的 `cwd` 分组**；不使用 Codex `project_id`、`.codex-global-state.json`、Claude 编码目录名、Hermes `projects.db`。
- 不做父目录汇总：`/a/b` 和 `/a/b/c` 是两个目录。
- 同名目录必须按完整路径分开；例如 `/work/app` 与 `/tmp/app`。
- 同一 cwd 下不同 Agent 的会话**不放在同一列表**；它们分别属于各自的 AgentView，通过顶部切换查看。
- 同一 Agent 在同一 cwd 下的会话按最近活动排序。

### 7.2 特殊路径

| 情况 | 处理 |
|---|---|
| 尾部 `/`、重复 `/` | 规范化后合并 |
| 反斜杠路径 | 统一转 `/` |
| `~` 开头 | 展开 home 后再规范化 |
| symlink | 存在时用 realpath 合并；不存在时保留字面路径 |
| 相对路径 | 视为无有效 cwd，进 `No directory` |
| cwd 为空/null | 进 `No directory` |
| 根目录 `/` | 独立目录，不把其他路径归入 |
| Unicode NFC/NFD | 统一 NFC 后比较 |
| 大小写 | 不主动转小写；macOS 由 realpath 处理 |
| 目录不存在 | 保留分组，标记 missing；恢复禁用 |
| 目录无权限 | 保留分组，标记 inaccessible；恢复禁用 |
| 路径含空格/引号 | 正常分组；命令必须安全引用 |

### 7.3 多根目录

- 本版只认 `cwd`。
- Codex `runtime_workspace_roots`、Codex `project_roots`、Hermes `project_folders` 不作为分组键；可作为 P1 的辅助信息展示，但不能改变目录分组。
- 一个会话如果 cwd 为空，即使它有 project/root 信息，也进入 `No directory`；不猜测目录。

### 7.4 归档、隐藏、子代理

- 归档/隐藏/子代理会话默认不进入目录列表，也不参与目录计数。
- P1 打开开关后，仍归入其 cwd；用徽标标记，不混成普通会话。
- 子代理不单独建立目录；找不到父会话时仍按自身 cwd 显示并标记。

---

## 8. Agent 适配规范

### 8.1 总表

| Agent | 数据源 | cwd 来源 | 标题优先级 | 内容 | 恢复命令 |
|---|---|---|---|---|---|
| Claude Code | `~/.claude/projects/*/*.jsonl` 顶层文件 | JSONL 中的 `cwd` | `custom-title` > `ai-title` > 首条用户文本 > `last-prompt` | JSONL 的 user/assistant 文本 | `cd <cwd> && claude --resume <id>` |
| Codex | app-server `thread/list`（`archived:false`、`useStateDbOnly:true`） | thread 的 `cwd` | `name` > `title` > `preview` > 首条用户文本 | app-server/rollout transcript | `codex --no-daemon -C <cwd> resume <id>` |
| Hermes | `~/.hermes/state.db` 的 `sessions` | `sessions.cwd`（可空） | `title` > 首条用户文本 | `messages` 表 | `cd <cwd> && hermes --resume <id>` |

适配器只负责产出 `Session`；UI 按 `Session.agent` 分到三个独立视图，不把三个适配器的结果混在一个列表。

### 8.2 Claude Code

**发现**

- 数据根默认 `~/.claude`，测试可用 helper 参数覆盖。
- 会话文件：`projects/<encoded-cwd>/<session-id>.jsonl`。
- **只读顶层文件**；`<session-id>/subagents/*.jsonl` 是子代理，不作为独立会话。
- 不从目录名反解 cwd；目录名是编码后的路径，可能丢失信息。cwd 以 JSONL 内的 `cwd` 为准。

**解析**

- `sessionId` 优先取 JSONL 行内值，缺失时用文件名（去掉 `.jsonl`）。
- `cwd` 取第一条出现的值；缺失则 `null`。
- 时间戳取 ISO 字符串，转换为 Unix 秒；无效按 0。
- 标题：最新 `custom-title.customTitle` > 最新 `ai-title.aiTitle` > 首条真实用户文本 > 最新 `last-prompt.lastPrompt` > `Untitled chat`。
- 预览只取 `type=user/assistant` 的文本块；`system`、`api-request`、`cost-state`、`file-history-*` 等忽略。
- 工具结果折叠为 `[tool]` 或省略，不把整段 JSON 塞进预览。

**运行状态**

- `~/.claude/sessions/<pid>.json` 提供 `sessionId`、`cwd`、`status`（`busy`/`idle`）、`updatedAt`。
- `busy` → Working；`idle` → Idle；其他/缺失 → Unknown。
- 必须校验 PID 是否仍存活；文件残留但进程已退出，视为历史，不显示运行中。
- 同一 session 多个 PID：取最新且存活的；仍不唯一 → 多实例/待确认。
- Herdr `agents()` 的状态优先于静态文件；静态文件只作线索。

**恢复**

- `cd <cwd> && claude --resume <session-id>`；具体参数以本机 `claude --help` 为准。
- 如果本机版本不支持该恢复参数：显示版本不兼容，禁用恢复，不尝试猜命令。
- cwd 缺失/不存在/无权限：禁用恢复，不静默使用 home。
- Claude 二进制不存在：历史仍可看，恢复按钮显示不可用原因。

### 8.3 Codex

**发现**

- 通过 `codex app-server --stdio` 调 `thread/list`，参数 `archived:false`、`useStateDbOnly:true`，分页取全。
- 不再调用 `project/list`；项目/assignment 不参与分组。
- 过滤 `thread_source` 不是 `user` 的线程；过滤 `parentThreadId` 非空的子线程。
- `archived` 线程由 app-server 排除；如果仍返回，适配器再过滤。

**解析**

- id → session id；cwd → 目录；`name` > `title` > `preview` > 首条用户文本。
- 时间戳接受数字秒、数字字符串、ISO；缺失按 0。
- 同一 thread id 重复时按最近活动去重。
- `originator` 只作为元数据，不参与目录分组；不区分 CLI/Desktop。

**内容**

- 优先复用现有 transcript helper；rollout 缺失时回退 `thread_history` 或显示可读错误。
- 只读，不修改 rollout/state。

**恢复**

- `codex --no-daemon -C <cwd> resume <thread-id>`。
- cwd 缺失/不存在/无权限：禁用恢复。
- 已有实例的定位逻辑沿用现有 Codex 匹配器。

### 8.4 Hermes

**发现**

- 数据根默认 `~/.hermes`，数据库 `state.db`。
- 只读查询 `sessions` 表：`hidden=0`；`archived` 作为标记默认隐藏；`parent_session_id` 非空视为子会话默认隐藏。
- `projects.db` 不参与分组；即使有项目，也按 `sessions.cwd` 分组。
- SQLite 使用只读/快照方式，避免锁库；WAL 活跃时允许读旧快照并提示 stale。

**解析**

- id → session id；`cwd` → 目录；`title` > 首条用户消息 > `Untitled chat`。
- `started_at`、`last_activity_at` 为 Unix 秒；缺失按 `started_at`。
- `messages` 表按 id/timestamp 排序；只渲染 user/assistant；tool 消息折叠。
- 压缩 lineage 的多个 session 由适配器投影为一条逻辑会话，保留最新 tip 的标题/时间。

**运行状态**

- Herdr `agents()` 中有 `hermes` Agent 时，以 Herdr 状态为准。
- `runtime/active_sessions.json` 有 entry 时可作为线索；为空不推断。
- `sessions.ended_at` 为空只表示“没有记录结束”，不能单独当作正在运行；结合 Herdr/最近活动判断。
- 状态未知时显示“已打开·状态未知”或纯历史，不伪造 working。

**恢复**

- `cd <cwd> && hermes --resume <session-id>`。
- Hermes 支持 `--resume <session_id>`；cwd 缺失/不存在/无权限时禁用恢复。
- 不要使用 `--resume latest` 代替明确 id。

### 8.5 检测、缺失与降级

| 情况 | 行为 |
|---|---|
| 数据根不存在 | 该 Agent 标记 unavailable；不显示空目录；不报致命错误 |
| 数据根存在但为空 | 该 Agent 显示 0；不影响其他 Agent |
| 二进制不存在 | 历史可见；恢复不可用，显示原因 |
| 某个适配器超时 | 该 Agent 保留旧缓存并标记 stale；其他 Agent 正常刷新 |
| 某个适配器解析失败 | 记录 warning；跳过坏记录，保留可解析记录 |
| 三个都失败 | 保留旧缓存；无缓存则空列表 + 错误与重试 |

三个适配器都支持用 helper 参数覆盖数据根，仅用于测试/隔离；用户默认路径不变。

---

## 9. 状态模型

### 9.1 五个独立维度

| 维度 | 取值 | 来源 |
|---|---|---|
| 历史同步 | loading / ready / partial / stale / error | 各 Agent 适配器与缓存 |
| 运行关联 | none / confirmed / inferred / ambiguous | 标签、argv、标题+cwd、时间窗 |
| 打开/呈现 | none / opening / previewing / preview / resuming / live / exited / failed | mod + Herdr |
| Agent 工作状态 | working / blocked / done / idle / unknown | Herdr `agents()`；Claude 静态文件作线索 |
| 位置 | focused / other-tab / no-pane / settled / none | Herdr |

组合示例：

> Claude 缓存 stale + 关联 confirmed + 终端 live + `busy` + 其他 tab。

### 9.2 用户可见状态与优先级

| 优先级 | 显示状态 | 进入条件 |
|---|---|---|
| 1 | 失败 | 最近一次打开/预览/恢复/标签写入失败 |
| 2 | 需要你处理 | 关联 Agent 为 `blocked` |
| 3 | 多实例/待确认 | 同一会话多个实例，或关联不唯一 |
| 4 | 执行中 | 关联 Agent 为 `working`（Claude `busy` 映射到此） |
| 5 | 完成·未查看 | 关联 Agent 为 `done`；仅当来源确实报告 done |
| 6 | 等待输入 | 关联 Agent 为 `idle` |
| 7 | 已打开·状态未知 | 终端 live，但没有可信 Agent 状态 |
| 8 | 已退出·可恢复 | Agent 退出；终端可能仍是占位 shell 或已 finished |
| 9 | 预览 | 已有预览 tab，未运行该会话 |
| 10 | 历史记录 | 有会话，没有已知打开实例 |

过渡状态短暂覆盖第 1–10 项；失败后落到“失败”，不能无限停留。

### 9.3 与 Herdr 状态的对应

| Herdr 事实 | 取值 | 本 mod 的解释 |
|---|---|---|
| terminal `state` | `live` / `finished` | 终端是否仍在运行；finished 不可直接操作 |
| Agent `status` | `working` / `blocked` / `done` / `idle` | 关联 Agent 当前在做什么 |
| Agent `app`/`program.key` | `claude` / `codex` / `hermes` | 决定使用哪个匹配器和恢复命令 |
| 无 Agent | 普通 shell 或其他程序 | 只能说明“已打开/未知” |
| Space/Tab 聚合状态 | 多个 Agent 的聚合 | 不能直接作为单条会话状态 |
| `settled` | 本屏幕收起 | 不影响运行和工作状态 |
| `focused` | 当前焦点 | 独立维度，不等于“已打开” |

规则：

- **`done` 不是进程退出**；用户查看后会变 `idle`。
- **`idle` 不是关闭**；进程仍可继续输入。
- **`blocked` 优先级最高**；不得自动发送继续指令。
- **不能从终端画面文字猜状态**；只使用 Herdr/适配器报告的事实。
- Claude 的 `busy` 只映射为 working；没有 `done` 就不显示 done。
- Hermes 没有可信状态时显示 unknown，不伪造 working。

### 9.4 计数

- 不显示全局 `已打开 N · 执行中 M` 汇总条。
- 切换器显示每个 Agent 的会话总数；不是当前页数量，也不包含其他 Agent。
- 目录行显示当前 Agent 在该目录下的会话总数；不是当前页数量。
- 打开/执行中状态只通过每条会话自己的状态徽标表达，不汇总成顶部数字。

### 9.5 关联置信度

| 置信度 | 判定 | 允许的行为 |
|---|---|---|
| confirmed | 显式标签/当前前台 argv 指向同一会话，且终端未复用 | 直接定位；可恢复/聚焦 |
| inferred | 标题+cwd 唯一匹配，或启动参数唯一匹配，或新会话时间窗唯一推断 | 可显示状态；恢复前尽量再次确认 |
| ambiguous | 多候选、标签过期、终端复用、标题重名且无 cwd 区分 | 显示待确认，不自动恢复 |
| none | 没有关联 | 按历史处理 |

---

## 10. 预览、恢复、space 与标签

### 10.1 预览

- 单击只读历史，不启动 Agent。
- 预览内容按 Agent 适配器解析；终端输出必须清理 ANSI/OSC/控制字符。
- 预览失败时保留 tab，显示原因和重试入口。
- 预览不写入 transcript、不修改数据库。

### 10.2 恢复

| Agent | 命令 | cwd 规则 |
|---|---|---|
| Claude Code | `claude --resume <session-id>` | `cd <cwd>` 后执行；cwd 必须存在 |
| Codex | `codex --no-daemon -C <cwd> resume <thread-id>` | 使用 cwd；不存在则禁用 |
| Hermes | `hermes --resume <session-id>` | `cd <cwd>` 后执行；cwd 必须存在 |

- 恢复前必须确认会话 id 和 Agent 类型，不能把 Claude id 传给 Codex。
- cwd 缺失/不存在/无权限：恢复按钮禁用，显示“Working directory unavailable”；不静默回退 home。
- 用户明确选择“在 home 打开”时才允许 fallback；P0 不提供该入口。
- 恢复命令退出非零：显示失败，保留 tab，可重试。
- 恢复中不能并发启动同一会话。

### 10.3 space 选择

按以下顺序：

1. 本机 space 的 `folder` 精确等于 cwd。
2. 本机 space 中存在 live pane，其 cwd 精确等于 cwd。
3. 没有匹配：新建 space，名称取目录名（根目录为 `root`），folder=cwd。
4. 不使用父目录、项目 root、Codex assignment、Claude 编码目录做匹配。

规则：

- 不把同一路径的会话放进不同 space；目录是唯一归属。
- 多个 space 同 folder 时不能静默乱选；按确定性规则选择并允许后续提示。
- 远端 machine 的 space 可以承载终端，但不读取远端历史。

### 10.4 tab 标题与标签

- 新 tab 标题使用会话标题；没有标题用 `Claude`/`Codex`/`Hermes` + `Untitled`。
- 识别到会话后跟随最新标题；用户手动改名后停止覆盖。
- 新标签命名空间：

```text
agent.kind=claude|codex|hermes
agent.session.id=<id>
agent.cwd=<cwd>
agent.managed=true
agent.placeholder=true|空
agent.tab.title=<mod 最后设置的标题>
agent.preview.exit=<code>
agent.resume.exit=<code>
```

- 兼容读取旧 `codex.thread.id`、`codex.project.id`、`codex.placeholder` 等标签；新写入统一 `agent.*`，并清理旧标签。
- 标签写入失败不阻塞预览/恢复；后续刷新重试。

---

## 11. 刷新、缓存与错误

### 11.1 同步

- 默认每 60 秒 + 手动 Refresh。
- 三个适配器并行；各自超时、各自缓存、各自 warning。
- Claude/Hermes 只读本地文件/数据库；Codex 启动 app-server。
- 同步中重复 Refresh 不并发。
- 同步失败保留旧数据；不要因为一个 Agent 失败清空整个列表。

### 11.2 缓存

- 路径：`~/.config/herdr-app/data/herdr-agent-history/history.json`。
- schemaVersion = 2；旧 `threads.json` 不迁移，直接重建。
- 内容：`syncedAt`、`directories`、`sessions`、`agentStatus`、`warnings`、`staleAgents`。
- 原子写入，权限 0600；不存 transcript 全文。
- schema 不匹配、损坏、不可读：视为无缓存，重新同步。
- 单个 Agent 失败：保留该 Agent 上次成功的数据，标记 stale；其他 Agent 更新。

### 11.3 错误与空状态

| 场景 | 展示 | 恢复方式 |
|---|---|---|
| 首次加载 | `Loading…` | 等待同步 |
| 没有任何会话 | `No sessions found` + 检查路径/刷新 | 检查 Agent 数据根 |
| 当前 Agent 没有会话 | `No Claude/Codex/Hermes sessions` | 切换 Agent/刷新 |
| 当前 Agent 不可用 | 切换按钮禁用 + 原因 | 安装/修复后刷新 |
| 目录下没有会话 | `No sessions in this directory` | 切换目录/刷新 |
| 单 Agent 不可用 | 该 Agent 切换按钮不可用 + 原因 | 安装/修复后刷新 |
| 单 Agent 解析失败 | 保留其他 Agent + warning | 查看日志/重试 |
| 缓存旧 | 列表 + “数据可能较旧” | 重试 |
| cwd 缺失 | 归入 `No directory`；恢复禁用 | 预览或手动打开 |
| 目录 missing/inaccessible | 标记 + 恢复禁用 | 恢复目录/权限后重试 |
| 预览失败 | 错误原因；tab 保留 | 重试 |
| 恢复失败 | 错误原因；释放锁 | 重试 |
| 标签失败 | warning；不阻塞主流程 | 下次刷新重试 |
| 渲染异常 | 兜底页 + Retry | 查看 Herdr 日志 |

---

## 12. 验收标准

### P0 发布门槛

| 编号 | 验收条件 |
|---|---|
| A-01 | 全新安装后 `herdr-app check` 通过，侧栏可显示 |
| A-02 | 顶部可切换 Claude/Codex/Hermes；每次只显示一个 Agent 的目录与会话，不混排 |
| A-03 | 同一 Agent 内按真实 cwd 分组；同名不同路径目录不合并；尾部斜杠/symlink 规范化正确 |
| A-04 | Agent 切换正确，目录/会话/计数/空状态随 Agent 整体切换；无 All |
| A-05 | 单击只读预览，不启动任何 Agent |
| A-06 | 三种 Agent 都能在正确 cwd 恢复正确 session id |
| A-07 | 已有实例时定位，不重复创建 tab/终端 |
| A-08 | working/blocked/done/idle/busy/unknown 显示正确，不伪造状态 |
| A-09 | 单 Agent 失败时其他 Agent 和旧缓存仍可用 |
| A-10 | cwd 缺失/不存在/无权限时恢复禁用并说明原因 |
| A-11 | 快速点击/重复双击不产生重复 tab 或重复 resume |
| A-12 | 归档/隐藏/子代理默认不进入主列表 |

### P1 验收条件

| 编号 | 验收条件 |
|---|---|
| B-01 | 每个 Agent 的分页、目录选择、页码收敛独立正确 |
| B-02 | tab 标题跟随会话；用户改名后不再覆盖 |
| B-03 | 多实例能展示并阻止误启动 |
| B-04 | 热重载后状态可从 Herdr 事实重建 |
| B-05 | 长路径、中文、emoji、窄侧栏不破版 |
| B-06 | 多 space 场景按精确 cwd 复用，不落入错误目录 |
| B-07 | 标签写入失败不影响主流程，且会重试 |
| B-08 | 搜索/归档开关/目录树实现后不破坏 P0 分组语义 |

---

## 13. 待定产品决策

| 编号 | 问题 | 建议默认 |
|---|---|---|
| D-01 | 目录树是否作为默认视图 | P0 平铺；P1 可选树，默认仍平铺 |
| D-02 | 归档会话是否可查看 | 默认隐藏；P1 开关 |
| D-03 | 子代理是否展示 | 默认隐藏；P1 折叠到父会话 |
| D-04 | 无 cwd 会话是否展示 | 展示在 `No directory`，恢复禁用 |
| D-05 | 目录不存在是否允许 home fallback | 默认不允许；用户显式选择才允许 |
| D-06 | 无匹配 space 时是否新建 | 新建目录 space，名称取目录名 |
| D-07 | Agent 切换器样式 | 一个按钮显示当前 Agent + 会话数；展开三选一菜单；不可用禁用；不能只靠颜色 |
| D-08 | Hermes 无 cwd 的 onboarding 会话 | 默认 hidden 已过滤；非 hidden 的进 No directory |
| D-09 | 搜索/目录树优先级 | P1；不阻塞 P0 |
| D-10 | 旧 `codex.*` 标签 | 读取兼容；新写入 `agent.*` |
| D-11 | 默认显示哪个 Agent | 记住上次选择；没有记录时按 Claude → Codex → Hermes 选第一个可用 |
| D-12 | 是否保留 All 混合视图 | 不保留；一次只显示一个 Agent |

---

## 14. 当前实现与目标的差距

当前代码是 Codex-only 版本，核心差距不是“再加两个数据源”，而是分组模型从 **project/assignment** 换成 **cwd**。

| 编号 | 当前行为 | 目标行为 |
|---|---|---|
| G-01 | 项目栏按 Codex project/assignment 分组 | 顶部 Agent 切换器 + 每个 Agent 内按真实 cwd 分组 |
| G-02 | helper 只调 Codex app-server `project/list` + `thread/list` | 三个适配器并行；Codex 不再需要 `project/list` |
| G-03 | 只支持 Codex transcript/resume | Claude/Hermes 各自的预览与恢复 |
| G-04 | 标签使用 `codex.*` | 通用 `agent.*`，兼容旧标签 |
| G-05 | 运行匹配只认 Codex | 按 `agent.kind` 分派匹配器 |
| G-06 | 状态只映射 Codex Agent | 统一状态模型，Claude busy/idle，Hermes unknown |
| G-07 | 缓存 schema 1 / `threads.json` | schema 2 / `history.json`，按 Agent 部分缓存 |
| G-08 | 无 cwd 会话进入 Unassigned/项目推断 | 进入 `No directory`，不猜目录 |
| G-09 | 子代理只打标不过滤 | 默认过滤，P1 可展开 |
| G-10 | 测试基线 69 个，全部 Codex-only | 新增目录、三适配器、统一匹配测试 |

实施顺序建议：

1. 先抽统一 `Session` / `DirectoryGroup` 模型和 cwd 规范化；
2. 把 Codex 适配器改成只产出 Session，不再产出项目；
3. 增加 Claude 适配器（JSONL + live 文件）；
4. 增加 Hermes 适配器（只读 SQLite）；
5. 改 UI 为 Agent 切换器 + 单 Agent 目录栏 + 单 Agent 会话列表；
6. 改标签/匹配/恢复为 `agent.*`；
7. 补测试与真实冒烟。

兼容性：

- 保留 mod id `herdr-codex-sidebar-mod`，避免安装路径断裂；显示名改为 `Agent History`。
- 旧缓存不迁移；首次同步重建。
- 旧 `codex.*` 标签只读兼容，不阻塞新标签写入。

---

## 15. 附录：轻量实现映射

### 模块职责（目标）

| 模块 | 职责 |
|---|---|
| `main.js` | Herdr UI、Agent 切换、目录选择、点击编排、tab/space 创建、标签同步 |
| `view-model.mjs` | 统一 Session/AgentView/DirectoryGroup 归一化、Agent 分区、分页、状态与计数 |
| `live-state.mjs` | Agent 类型识别、通用标签、会话匹配、置信度 |
| `launch-target.mjs` | cwd 校验、space 精确匹配、各 Agent 恢复命令、shell 引用 |
| `helper/agent-history.mjs` | `sync` / `preview` / `status` / `reconcile` CLI |
| `helper/lib/adapters/claude.mjs` | Claude Code JSONL、live 文件、标题、预览 |
| `helper/lib/adapters/codex.mjs` | Codex app-server thread/list、transcript、运行匹配 |
| `helper/lib/adapters/hermes.mjs` | Hermes state.db、messages、live 线索、预览 |
| `helper/lib/normalize.mjs` | cwd 规范化、Agent 分区、目录分组、去重、排序 |
| `helper/lib/cache.mjs` | schema 2 缓存、原子写入、0600 |
| `helper/lib/transcript.mjs` | 通用 transcript 渲染与 ANSI 清理 |

### 数据流

```text
Claude JSONL ─┐
Codex app-server ├─> 各 Agent 适配器 ─> 统一 Session[] ─> 按 Agent 分区 ─> cwd 分组 ─> history.json
Hermes state.db ─┘                                      │
                                                        ▼
Herdr terminals/panes/agents/spaces ─────────────> 当前 AgentView + 状态匹配 + 点击编排
                                                        │
                                      tab.new / space.new / terminal.keep
                                                        │
                                      agent.* 标签 + 预览/恢复命令
```

### Herdr API 使用

| API/命令 | 用途 |
|---|---|
| `spaces()` / `panes()` / `terminals()` / `agents()` | 读取 live 事实 |
| `run("tab.new" / "space.new")` | 创建预览/恢复目标 |
| `run("tab.select" / "space.select" / "pane.focus")` | 定位已有实例 |
| `run("terminal.keep")` | 挂回无 Pane 的终端 |
| `run("tab.rename")` | 同步 tab 标题 |
| `exec(helper, ["sync", ...])` | 拉取三 Agent 历史 |
| `exec(hc, ["label", ...])` | 写通用标签 |
| `exec(hc, ["send", ...])` | 在预览/恢复 tab 中执行命令 |

### 为什么暂不单独写开发文档

- 当前规模下，模块边界和适配器接口已经能说明实现。
- 真正容易出错的是 cwd 规范化、Agent 切换、状态关联和恢复命令；这些放在本文第 4、7、8、9、10 节和测试文档中。
- 当出现第二个长期贡献者、需要对外 API 或拆成多进程时，再补薄的 `ARCHITECTURE.md`。
