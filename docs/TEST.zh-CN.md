# Herdr Agent 历史侧栏 Mod 测试方案

| 项目 | 内容 |
|---|---|
| 文档版本 | v0.2 |
| 日期 | 2026-11-04 |
| 状态 | 目标测试矩阵（Draft） |
| 适用版本 | 0.2.x |
| 配套文档 | [产品功能文档](PRODUCT.zh-CN.md) |

> 本文定义**目标行为的验收矩阵**。`自动` 用例应逐步进入 `npm test`；尚未落地的用例不能当作已通过。当前基线见 0.2。

---

## 0. 使用说明

### 0.1 图例

| 标记 | 含义 |
|---|---|
| `自动` | 应进入 `npm test` 的 Node 测试 |
| `手工` | 需要 Herdr GUI、真实 Agent 或系统权限 |
| `已有` | 当前测试已覆盖，且目标行为不变 |
| `部分` | 当前测试覆盖了旧行为，需要按新模型调整 |
| `待补` | 目标行为需要新增测试 |
| `缺陷` | 已复现、尚未修复 |

### 0.2 当前基线

| 项目 | 现状 | 说明 |
|---|---|---|
| `npm test` | 132/132 通过 | 覆盖两个适配器、cwd 分组、恢复命令、预览、缓存与 UI 纯函数 |
| `herdr-app check` | 仓库与安装目录通过 | 安装/加载基线 |
| cwd 分组 | 已实现 | 每个 Agent 内按真实 cwd 精确分组 |
| Agent 切换 | 已实现 | Claude / Codex 二选一，没有 All |
| Claude 适配 | 已实现 | JSONL + live 文件 |
| Codex 适配 | 已实现 | app-server `thread/list` + rollout 预览（含 `.jsonl.zst`） |
| 统一 `agent.*` 标签 | 已实现 | 兼容读取旧 `codex.*` |
| 真实 GUI 冒烟 | 基础路径已覆盖 | 发布前仍需手工复核 |

发布门槛：**P0 用例全部通过**；P1 允许有记录明确的非阻塞缺陷；真实冒烟至少覆盖两个 Agent 各一条。

### 0.3 判定原则

1. **目录按真实 cwd 精确分组**，不按 project、assignment、编码目录名、父目录汇总。
2. **不同 Agent 不混排**；顶部切换 Agent 后只显示该 Agent 的目录与会话，不同 Agent 的同名 id 不合并。
3. **cwd 缺失/不存在/无权限时不得静默回退 home**；恢复必须禁用并说明原因。
4. **历史状态与运行状态分离**；不得从终端文字猜 Agent 状态，不得伪造 `done`。
5. **同一会话不得重复启动**；重复点击、快速双击、刷新期间都不能产生重复 tab。
6. **单 Agent 失败不影响其他 Agent**；旧缓存可降级使用，但要标记 stale。
7. **只读历史**；测试结束不得修改真实用户数据。
8. **每个用例都要有可观察结果**：UI 文本、helper JSON、进程/终端数量、缓存内容至少一项。

### 0.4 环境矩阵

| 维度 | 覆盖值 |
|---|---|
| OS | macOS（主）、Linux（CI 可选） |
| Node | 仓库声明的 LTS 版本 |
| Herdr | 当前发布版；至少一个旧版做兼容 |
| Agent 安装 | 两个全装、只装一个、全部未装、二进制存在但数据根不存在 |
| 数据根 | 默认根、临时隔离根、空根、只读根、损坏文件 |
| cwd | 普通、深层、含空格/引号、中文、emoji、NFC/NFD、symlink、root、缺失、无权限 |
| 会话类型 | 普通、archived、hidden、subagent、多实例、无 cwd |
| 终端状态 | live/finished、focused/非 focused、settled、无 Pane |
| Agent 状态 | working/blocked/done/idle/unknown |
| 主题/尺寸 | 浅色/深色、窄侧栏、宽侧栏、缩放 |
| 语言 | 中文、英文、混合、超长标题 |

### 0.5 测试隔离

- 所有自动化使用临时目录，不读取真实 `~/.claude`、`~/.codex`。
- Codex：`CODEX_HOME=<tmp>/codex`；Claude：helper `--claude-home <tmp>/claude`（若测试版本支持 `CLAUDE_CONFIG_DIR`，可额外覆盖）。
- Herdr 状态、缓存目录、日志目录同样指向临时路径。
- Claude fixture：合成 `projects/<encoded>/<id>.jsonl`，包含 `sessionId`、`cwd`、`custom-title`/`ai-title`、user/assistant 行；子代理放 `<id>/subagents/`。
- Codex fixture：fake app-server 返回 `thread/list`；不依赖真实 Codex 登录。
- 每个用例结束删除临时目录；失败时保留到 `/tmp/agent-history-test-<id>/` 便于排查。

### 0.6 目标测试文件映射

| 文件 | 覆盖 |
|---|---|
| `test/normalize.test.mjs` | cwd 规范化、目录分组、去重、排序、过滤 |
| `test/view-model.test.mjs` | 目录/会话视图、Agent 切换、分页、切换器/目录计数、状态标签 |
| `test/live-state.test.mjs` | Agent 类型识别、标签优先级、匹配置信度 |
| `test/launch-target.test.mjs` | cwd 校验、space 选择、两 Agent 恢复命令、shell 引用 |
| `test/helper.test.mjs` | sync/preview/status、缓存、部分失败 |
| `test/adapters-claude.test.mjs` | Claude JSONL、标题、live 文件 |
| `test/adapters-codex.test.mjs` | Codex app-server、转写、过滤 |
| `test/directory-view.test.mjs` | 目录/Agent 视图/切换的纯函数 |
| `test/contract.test.mjs` | 统一 Session/DirectoryGroup schema |
| `test/install.test.mjs` | 安装、必需文件、可执行权限、无开发者绝对路径 |
| `test/transcript.test.mjs` | transcript 解析、ANSI 清理、预览渲染 |

### 0.7 常用命令

```sh
npm test
node --test test/normalize.test.mjs test/adapters-claude.test.mjs
herdr-app check
herdr-app check --install
```

隔离调用示例（目标 CLI）：

```sh
CODEX_HOME=/tmp/ah-codex \
node mods/herdr-codex-sidebar-mod/helper/agent-history.mjs sync \
  --json --cache /tmp/ah-cache/history.json --claude-home /tmp/ah-claude
```

### 0.8 结果记录模板

| 用例 | 环境 | 结果 | 证据 | 备注 |
|---|---|---|---|---|
| DIR-01 | macOS / Node x | PASS | helper JSON + 截图 | 两 Agent 同 cwd，切换后各自独立 |

---

## 1. 安装与加载（INST）

| ID | 类型 | 前置/步骤 | 期望 |
|---|---|---|---|
| INST-01 | 自动/手工 | 从仓库安装 mod，重启 Herdr | 侧栏出现 `Agent History`；无报错 |
| INST-02 | 手工 | 从安装目录加载，执行 `herdr-app check` | 通过；helper 路径正确 |
| INST-03 | 自动 | 删除/破坏 `mod.json` | 加载失败有明确错误；不崩溃 |
| INST-04 | 自动 | 检查面板标题 | 显示 `Agent History`，不再显示 `codex desktop` |
| INST-05 | 自动 | 两个数据根都不存在 | 面板空状态 + 切换器两个选项不可用及原因；不报致命错误 |
| INST-06 | 自动 | 数据存在但两个二进制都不存在 | 历史可见；恢复按钮禁用并说明原因 |
| INST-07 | 自动 | helper 文件缺失/不可执行 | UI 显示错误与重试；不静默空列表 |
| INST-08 | 手工 | 修改源码后热重载 | 新代码生效；不重复面板/不丢选择 |
| INST-09 | 自动 | 仓库复制到其他路径后安装 | 不依赖开发者绝对路径 |
| INST-10 | 自动 | 缓存目录不可写（只读/权限） | 仍能读历史；缓存失败有 warning；不崩溃 |

---

## 2. 统一同步（SYNC）

| ID | 类型 | 前置/步骤 | 期望 |
|---|---|---|---|
| SYNC-01 | 自动 | 两套 fixture 各 2 条会话，执行 sync | 返回两个 Agent 的 Session；目录正确 |
| SYNC-03 | 自动 | Claude 适配器超时 | 在超时上限内返回；Claude 标记 stale；其他正常 |
| SYNC-04 | 自动 | 连续两次 sync | 缓存 schemaVersion=2；内容为最新；无重复会话 |
| SYNC-05 | 自动 | 模拟写入中断 | 旧缓存仍可读；新缓存不半写 |
| SYNC-06 | 自动 | 缓存 JSON 损坏/schema=1 | 视为无缓存并重建；不崩溃 |
| SYNC-07 | 自动 | 并发触发两次 sync | 不产生交叉写；最终缓存一致 |
| SYNC-08 | 自动 | 两个数据根都为空 | 返回空 directories；无错误；下次可刷新 |
| SYNC-09 | 自动 | 第一次成功，第二次 Claude 失败 | Claude 保留旧数据 + stale；其他更新 |
| SYNC-10 | 自动 | 执行 status/reconcile | 状态与缓存、Herdr 事实一致；不重复启动 |
| SYNC-12 | 自动 | mock Codex app-server | 只调用 `thread/list`；不调用 `project/list` |
| SYNC-14 | 自动 | 两个适配器返回相同 warning | warning 去重；顺序稳定 |
| SYNC-15 | 自动 | 检查缓存文件权限 | 0600；不包含 transcript 全文 |
| SYNC-16 | 自动 | 1000 条会话 | 同步在可接受时间内完成；无 O(n²) 卡死 |

---

## 3. cwd 分组（DIR）

| ID | 类型 | 前置/步骤 | 期望 |
|---|---|---|---|
| DIR-02 | 自动 | `/work/app` 与 `/tmp/app` | 两个目录组；不按 basename 合并；显示最短可区分后缀（如 `work/app`、`tmp/app`），不常驻完整路径 |
| DIR-03 | 自动 | cwd 带尾部 `/` 与不带 | 同一目录组 |
| DIR-04 | 自动 | cwd 含重复 `/` | 规范化后同一组 |
| DIR-05 | 自动 | symlink 指向真实目录 | 存在时 realpath 合并；完整路径仅在 tooltip/冲突时出现 |
| DIR-06 | 自动 | symlink 目标不存在 | 保留字面路径；不崩溃 |
| DIR-07 | 自动 | cwd 为相对路径 | 进 `No directory`；不猜 home |
| DIR-08 | 自动 | cwd 为 null/空字符串 | 进 `No directory` |
| DIR-09 | 自动 | cwd 为 `/` | 独立根目录组；不吞并其他路径 |
| DIR-10 | 自动 | 中文、emoji、NFC/NFD 路径 | 正确显示/分组；NFC 等价路径合并 |
| DIR-11 | 自动 | 大小写不同的路径 | 不主动转小写；按真实文件系统语义 |
| DIR-12 | 自动 | 路径含空格、单引号、双引号 | 分组正确；恢复命令安全引用 |
| DIR-13 | 自动 | cwd 不存在但会话存在 | 目录保留 + missing；恢复禁用 |
| DIR-14 | 自动 | cwd 存在但无读权限 | 标记 inaccessible；预览可读历史；恢复禁用 |
| DIR-15 | 自动 | 会话 cwd 是 `/a/b/c`，另有 `/a/b` | 两个目录；不做父目录汇总 |
| DIR-16 | 自动 | Codex thread 有 projectId/roots，cwd 为空 | 不按 project 归组；进 No directory |
| DIR-17 | 自动 | archived 会话 | 默认不进入目录/计数 |
| DIR-19 | 自动 | Claude subagent | 默认不进入目录；不单独建组 |
| DIR-20 | 自动 | 多目录最近活动不同 | 目录按 lastActivityAt 倒序；No directory 最后 |
| DIR-21 | 自动 | 无 cwd 会话与有 cwd 会话 | No directory 固定最后；不可恢复 |
| DIR-22 | 自动 | 选中目录后刷新，目录仍存在 | 保留选择 |
| DIR-23 | 自动 | 选中目录刷新后消失，但还有其他目录 | 回退到第一个可用目录 |
| DIR-24 | 自动 | 同步临时失败返回空 | 不立即清除保存的选择 |
| DIR-25 | 自动 | 路径含 `..` | 存在时 realpath 归一；不存在时保留字面并标记 |
| DIR-26 | 自动 | `~` 开头 cwd | 展开 home 后分组 |
| DIR-27 | 自动 | 反斜杠路径 | 统一为 `/` 后分组 |
| DIR-28 | 自动 | 两个不同路径经规范化后 key 相同 | 合并为一个组；保留原始 cwd 供恢复 |

---

## 4. Claude Code 适配（ADPT-CLAUDE）

| ID | 类型 | 前置/步骤 | 期望 |
|---|---|---|---|
| CL-01 | 自动 | `projects/<encoded>/<id>.jsonl` | 发现一条会话；id 正确 |
| CL-02 | 自动 | 顶层 session 下有 `subagents/*.jsonl` | 只算顶层一条；子代理默认不显示 |
| CL-03 | 自动 | 目录名编码与 cwd 不一致 | 以 JSONL 的 `cwd` 为准；不反解目录名 |
| CL-04 | 自动 | JSONL 无 `sessionId` | 用文件名去 `.jsonl` 作为 id |
| CL-05 | 自动 | 首行无 cwd，后续行有 | 取首个有效 cwd |
| CL-06 | 自动 | 全文件无 cwd | 进 No directory；恢复禁用 |
| CL-07 | 自动 | 有 `custom-title` 与 `ai-title` | 取最新 custom-title |
| CL-08 | 自动 | 只有 `ai-title` | 使用 ai-title |
| CL-09 | 自动 | 没有标题事件，有用户文本 | 取首条真实用户文本并截断 |
| CL-10 | 自动 | 只有 `last-prompt` | 使用 last-prompt |
| CL-11 | 自动 | 标题事件重复/乱序 | 取最新时间/最后一条有效值 |
| CL-12 | 自动 | 空文件、坏 JSON 行、缺字段 | 跳过坏行；不崩溃；保留可解析会话 |
| CL-13 | 自动 | `isSidechain`/子代理行 | 不计入主会话消息 |
| CL-14 | 自动 | 工具调用/工具结果 | 预览折叠为 `[tool]`，不塞原始 JSON |
| CL-15 | 自动 | `~/.claude/sessions/<pid>.json` status=busy | 关联会话显示 working；校验 PID 存活 |
| CL-16 | 自动 | status=idle | 显示 idle；不显示 done |
| CL-17 | 自动 | 静态文件 PID 已退出 | 不显示运行中；按历史处理 |
| CL-18 | 自动 | 同一 session 多个存活 PID | 显示多实例/待确认；不自动选 |
| CL-19 | 自动 | 恢复命令 | `cd <cwd> && claude --resume <id>`；cwd 正确引用 |
| CL-20 | 自动 | 预览 | 只读 JSONL；不启动 claude |
| CL-21 | 自动 | 二进制不存在 | 历史可见；恢复禁用并说明 |
| CL-22 | 自动 | 两个会话同 id 不同文件 | 去重，取最近/更完整一条 |
| CL-23 | 自动 | 大文件（>50MB） | 不阻塞主线程；只解析所需字段 |

---

## 5. Codex 适配（ADPT-CODEX）

| ID | 类型 | 前置/步骤 | 期望 |
|---|---|---|---|
| CX-01 | 自动 | fake app-server 返回 `thread/list` | 生成 Session；id/cwd 正确 |
| CX-02 | 自动 | 检查调用记录 | 不调用 `project/list` |
| CX-03 | 自动 | `thread_source=guardian_review` | 默认过滤，不作为用户会话 |
| CX-04 | 自动 | `parentThreadId` 非空 | 视为 subagent，默认过滤 |
| CX-05 | 自动 | `thread_source=user`、无 parent | 正常展示 |
| CX-06 | 自动 | cwd 为空 | 进 No directory；不按 project 推断 |
| CX-07 | 自动 | title/name/preview 都存在 | 按 `name > title > preview` 取标题 |
| CX-08 | 自动 | timestamps 为秒/毫秒/ISO/字符串 | 统一为秒；无效按 0 |
| CX-09 | 自动 | archived=true 被返回 | 适配器再次过滤 |
| CX-10 | 自动 | rollout/transcript 缺失 | 预览显示可读错误；列表仍有会话 |
| CX-11 | 自动 | 同一 thread id 重复 | 去重，取最近 |
| CX-12 | 自动 | app-server 超时/退出 | 保留旧缓存 + stale；其他 Agent 正常 |
| CX-13 | 自动 | `thread/list` 分页 | 取全量；不因 limit 丢会话 |
| CX-14 | 自动 | 恢复 | `codex --no-daemon -C <cwd> resume <id>` |
| CX-15 | 自动 | cwd 不存在 | 恢复禁用；不静默用 home |
| CX-16 | 自动 | 旧 project/assignment 字段存在 | 完全不影响目录分组 |
| CX-17 | 自动 | 预览 | 不启动 Codex；不修改 rollout/state |

---

## 6. 列表、Agent 切换与分页（LIST）

| ID | 类型 | 前置/步骤 | 期望 |
|---|---|---|---|
| LST-01 | 自动 | 三目录、不同 Agent | 目录列表计数正确 |
| LST-02 | 自动 | 选中目录 | 右侧只显示该目录会话 |
| LST-03 | 自动 | Claude/Codex 切换（无 All） | 目录/会话/计数/空状态整体切换；一次只显示一个 Agent |
| LST-04 | 自动 | 某 Agent 0 条 | 切换器菜单项仍可见但不可用/显示无数据；不显示空目录 |
| LST-05 | 自动 | 切换 Agent 后目录无会话 | 该 AgentView 显示空状态；不借用其他 Agent 的目录 |
| LST-06 | 自动 | 无 cwd 会话 | No directory 显示；不可恢复 |
| LST-07 | 自动 | 空数据 | 明确空状态 + 刷新入口 |
| LST-08 | 自动 | 目录下 13 条会话 | 第 1 页 12 条；第 2 页 1 条 |
| LST-09 | 自动 | 切换目录再切回 | 恢复该目录页码 |
| LST-10 | 自动 | 删除/归档导致列表变短 | 页码自动收敛 |
| LST-11 | 自动 | 长标题/长目录名 | 中间省略；不横向溢出 |
| LST-12 | 手工 | 窄侧栏 | Agent 切换器、目录名、状态仍可读 |
| LST-13 | 自动 | 同名标题跨 Agent | 不同 Agent 不同时出现；切换后各自显示，不合并 |
| LST-14 | 自动 | 同名标题同 Agent | 两行都显示；不按标题去重 |
| LST-15 | 自动 | 刷新中 | 显示 loading；保留旧列表；不闪空 |
| LST-16 | 自动 | 部分 Agent stale | 列表可见 + stale 标记；不阻塞选择 |
| LST-17 | 手工 | 点击目录 | 不切换 Herdr space/tab |
| LST-18 | 自动 | 显示 archived/subagent（P1 开关） | 有明确标记；不混为普通会话 |
| LST-19 | 自动 | Claude 选目录 A、第 2 页；切到 Codex 选目录 B；再切回 Claude | Claude 恢复目录 A/第 2 页；Codex 保持目录 B；互不覆盖 |
| LST-20 | 自动 | 当前 Agent 刷新失败 | 保持当前 Agent + 旧缓存 + stale；不自动切到其他 Agent |
| LST-22 | 自动 | 当前 Agent 刷新后变为不可用 | 切换到第一个可用 Agent；显示原因，不显示混合数据 |
| LST-23 | 手工 | 切换 Agent | 只切换侧栏视图；不切换 Herdr space/tab/pane 焦点 |
| LST-24 | 手工 | 点击右上角 Agent 切换按钮 | 展开两个选项；无 All；当前项有勾选/高亮 |
| LST-25 | 手工 | 打开菜单后点外部/Esc | 关闭菜单且不切换 Agent |
| LST-26 | 自动 | 检查标题栏 | 不显示 `已打开 N · 执行中 M` 汇总条 |
| LST-27 | 自动 | 选中目录并查看会话列表 | 会话列表上方不显示 `• /Users/.../cwd` 路径行 |
| LST-28 | 自动 | 两个不同路径同名目录 | 默认只显示目录名；冲突时显示最短可区分后缀/tooltip，不显示完整路径行 |

---

## 7. 预览（PREV）

| ID | 类型 | 前置/步骤 | 期望 |
|---|---|---|---|
| PRV-01 | 自动 | 单击 Claude 会话 | 只读预览；不启动 claude |
| PRV-02 | 自动 | 单击 Codex 会话 | 只读预览；不启动 codex |
| PRV-04 | 自动 | 预览已存在 | 复用 tab；不重复创建 |
| PRV-05 | 自动 | transcript 缺失 | 错误原因 + 重试；tab 保留 |
| PRV-06 | 自动 | malformed JSONL/DB | 跳过坏记录；不崩溃 |
| PRV-07 | 自动 | 内容含 ANSI/OSC/控制字符 | 清理后显示；不执行控制序列 |
| PRV-08 | 自动 | 工具调用/图片 | 折叠为可读占位；不输出原始大 JSON |
| PRV-09 | 自动 | 超大 transcript | 限制渲染条数/大小；UI 不卡死 |
| PRV-10 | 自动 | cwd 不存在 | 仍可预览；显示 missing 提示 |
| PRV-11 | 自动 | 预览失败后重试 | 能重新执行；不叠加 tab |
| PRV-12 | 手工 | 运行中的会话单击 | 优先聚焦已有实例；不新建预览 |

---

## 8. 恢复与打开（OPEN）

| ID | 类型 | 前置/步骤 | 期望 |
|---|---|---|---|
| OPN-01 | 自动 | Claude 历史，双击 | `claude --resume <id>` 在正确 cwd |
| OPN-02 | 自动 | Codex 历史，双击 | `codex --no-daemon -C cwd resume id` |
| OPN-04 | 自动 | cwd 缺失/不存在/无权限 | 恢复禁用；不启动；原因可见 |
| OPN-05 | 自动 | 二进制不存在 | 恢复禁用；历史仍可预览 |
| OPN-06 | 自动 | 已有 live 实例 | 聚焦/挂回；不新建 |
| OPN-07 | 自动 | 已有预览 tab | 复用预览 tab 恢复 |
| OPN-08 | 自动 | 快速双击两次 | 只创建一个 tab/一个 resume |
| OPN-09 | 自动 | 恢复中再次双击 | 不叠加命令；提示进行中 |
| OPN-10 | 自动 | 同会话多实例 | 展示实例；不自动选/不误启动 |
| OPN-11 | 自动 | 错误 Agent id | 拒绝执行；不把 id 传给另一个 Agent |
| OPN-12 | 自动 | 恢复命令非零退出 | 显示失败；释放锁；可重试 |
| OPN-13 | 自动 | 精确 folder 的 space 存在 | 复用该 space；不按父目录 |
| OPN-14 | 自动 | 无匹配 space | 新建 space，名称=目录名，folder=cwd |
| OPN-15 | 自动 | 同名不同路径 | 不误用另一个路径的 space |
| OPN-16 | 自动 | 标签写入失败 | 不阻塞恢复；记录 warning；后续重试 |

---

## 9. 实时匹配与状态（MATCH/STATE）

| ID | 类型 | 前置/步骤 | 期望 |
|---|---|---|---|
| MAT-01 | 自动 | Herdr Agent app=claude | 识别为 Claude；使用 Claude 匹配器 |
| MAT-02 | 自动 | app=codex | 识别为 Codex |
| MAT-04 | 自动 | 通用 `agent.kind/session.id` 标签 | confirmed 关联；优先于标题 |
| MAT-05 | 自动 | 当前前台 argv 为 `--resume <id>` | 按 Agent 解析；confirmed |
| MAT-06 | 自动 | 标题+cwd 唯一匹配 | inferred；可提示 |
| MAT-07 | 自动 | 标题重名且同 cwd | ambiguous；不自动恢复 |
| MAT-08 | 自动 | 启动时间窗内出现新 Agent | inferred；仅唯一候选 |
| MAT-09 | 自动 | 无任何证据 | none；按历史处理 |
| MAT-10 | 自动 | Claude live 文件 busy | working；Herdr 状态优先 |
| MAT-11 | 自动 | Claude live 文件 idle | idle；不伪造 done |
| MAT-12 | 自动 | Herdr status=done | 显示完成·未查看；不显示为进程退出 |
| MAT-13 | 自动 | Herdr status=blocked | 需要你处理；最高优先级 |
| MAT-14 | 自动 | 终端 live 但无 Agent | 已打开·状态未知 |
| MAT-15 | 自动 | 终端 finished | 已退出·可恢复；只显示单条状态，不汇总 |
| MAT-16 | 自动 | 多实例状态 | 每个实例独立状态；不合并、不重复 |
| MAT-17 | 自动 | 历史且无实例 | 仅历史记录；不显示运行状态徽标 |

---

## 10. 标签与 tab（TAB）

| ID | 类型 | 前置/步骤 | 期望 |
|---|---|---|---|
| TAB-01 | 自动 | 新建预览/恢复 tab | 写入 `agent.kind`、`agent.session.id`、`agent.cwd` |
| TAB-02 | 自动 | 旧 `codex.*` 标签 | 可读取并迁移为新标签；不重复 |
| TAB-03 | 自动 | 用户手动改名 | 停止覆盖标题 |
| TAB-04 | 自动 | 会话标题更新 | 未手动改名时跟随 |
| TAB-05 | 自动 | 标签含空格/引号/中文 | 正确写入/读取；无 shell 注入 |
| TAB-06 | 自动 | 标签写入失败 | 不阻塞；warning；重试 |
| TAB-07 | 自动 | 终端退出 | 清理 stale 标签；保留会话历史 |
| TAB-08 | 自动 | 重启 Herdr | 从 Herdr 事实 + 标签重建；不重复 tab |
| TAB-09 | 自动 | 多 Agent 同名标题 | tab 标题仍可区分；不以标题去重 |

---

## 11. 多 space / 多实例（MULTI）

| ID | 类型 | 前置/步骤 | 期望 |
|---|---|---|---|
| MUL-01 | 自动 | 两个 space 同 folder | 按确定性规则选择；不静默乱选 |
| MUL-02 | 自动 | 两个 space 不同 folder | 精确 cwd 匹配 |
| MUL-03 | 自动 | 同 basename 不同路径 | 不串 space |
| MUL-04 | 自动 | 当前 space 无匹配 | 新建目录 space |
| MUL-05 | 自动 | 远端 machine 有终端 | 可定位终端；不读远端历史 |
| MUL-06 | 自动 | 同会话多个 pane | 多实例展示；不自动选 |
| MUL-07 | 自动 | 无 cwd 会话 | 不创建 space；仅预览 |
| MUL-08 | 手工 | 多 space 下恢复 | 目标 cwd 正确；不切错 space |

### 12.1 恢复目录与 fallback（RESUME-FALLBACK / SPACE-VALID / LIVE-CWD / UI-FALLBACK）

| ID | 类型 | 前置/步骤 | 期望 |
|---|---|---|---|
| RESUME-FALLBACK-01 | 自动 | 原 cwd 有效 + binary 存在 | `mode: original`；命令使用原目录 |
| RESUME-FALLBACK-02 | 自动 | 原 cwd 失效 + fallback 有效 | `mode: fallback`；不再显示 `No resume` |
| RESUME-FALLBACK-03 | 自动 | 原 cwd 失效且无 fallback | `mode: fallback-required`；不启动命令 |
| RESUME-FALLBACK-04 | 自动 | binary 缺失或 adapter 禁止恢复 | `mode: unavailable`；预览仍可用 |
| RESUME-FALLBACK-05 | 自动 | 严格模式 + cwd 失效 | `mode: preview-only`；双击只预览 |
| RESUME-FALLBACK-06 | 自动 | Codex fallback | argv 不含 `-C`；placeholder 命令含 `cd <fallback>` |
| RESUME-FALLBACK-08 | 自动 | Claude fallback | 直接 argv 仍为 `--resume <id>`；placeholder 显式 `cd` |
| RESUME-FALLBACK-09 | 自动 | fallback 优先级 | 全局 > Agent > 统计默认值；无效值跳过并 warning |
| RESUME-FALLBACK-10 | 自动 | 统计默认值 | 现存目录公共父目录；否则出现最多目录；全部缺失时 `valid: false` |
| SPACE-VALID-01 | 自动 | space.folder 精确等于 effectiveCwd 且存在 | 复用该 space |
| SPACE-VALID-02 | 自动 | 候选 space 的 folder 已被删除 | 不复用；新建 folder 为 effectiveCwd 的 space |
| SPACE-VALID-03 | 自动 | 同名目录多个 space | 按 space id 确定性选择 |
| SPACE-VALID-04 | 自动 | 并发恢复同一 fallback | 只创建一个 space；第二次复用 |
| LIVE-CWD-01 | 自动 | fallback 恢复后 `agent.cwd=effectiveCwd` | live 匹配命中，不因原 cwd 失效丢失 |
| LIVE-CWD-02 | 自动 | fallback 恢复后标题与 live 标题一致 | 标题候选使用 effectiveCwd 判断 |
| LIVE-CWD-03 | 自动 | 标签按 session id 命中 | 仍优先于标题/cwd 推断 |
| UI-FALLBACK-01 | 自动 | 原目录失效 + fallback | 会话行显示 `Resume in <dir>`，tooltip 说明原目录 |
| UI-FALLBACK-02 | 自动 | 原目录失效且无 fallback | 显示 `Set fallback`，双击打开编辑器 |
| UI-FALLBACK-03 | 自动 | binary 缺失 / adapter 拒绝 | 显示 `Unavailable`，保留预览 |
| UI-FALLBACK-04 | 自动 | 严格模式 | 显示 `Preview only` |
| UI-FALLBACK-05 | 手工 | 保存 fallback | 相对路径/不存在目录被拒绝；保存后继续恢复原会话 |
| UI-FALLBACK-06 | 手工 | `Only this Agent` | 只影响当前 Agent，其他 Agent 配置不变 |
| UI-FALLBACK-07 | 自动 | missing 目录排序 | 活跃 → `Missing (n)` 折叠区 → `No directory`；missing 不并入 No directory |
| UI-FALLBACK-08 | 自动 | 显式 `Move to directory…` | 只改本地分组/effectiveCwd；不写 Agent 原始数据 |
| UI-FALLBACK-09 | 自动 | override 目录被删除 | warning 并回退到 original/fallback |

---

## 12. 错误与降级（ERR）

| ID | 类型 | 前置/步骤 | 期望 |
|---|---|---|---|
| ERR-01 | 自动 | Claude JSONL 全部损坏 | 该 Agent warning；其他正常 |
| ERR-02 | 自动 | Codex app-server 不可用 | 旧缓存 + stale；其他正常 |
| ERR-04 | 自动 | 缓存不可读/损坏 | 重建；UI 不崩溃 |
| ERR-05 | 自动 | 数据根无权限 | 该 Agent 不可用；说明原因 |
| ERR-06 | 自动 | 两个 Agent 全失败且无缓存 | 空列表 + 错误 + 重试 |
| ERR-07 | 自动 | 单条会话解析失败 | 跳过该条；保留同 Agent 其他会话 |
| ERR-08 | 自动 | 刷新失败后恢复 | 手动重试成功；状态清除 |
| ERR-09 | 自动 | UI 渲染异常 | 兜底页 + Retry；不白屏 |

---

## 13. UI、性能与安全（UI/PERF/SEC）

| ID | 类型 | 前置/步骤 | 期望 |
|---|---|---|---|
| UI-01 | 手工 | 浅色/深色主题 | 文本/徽标对比度足够；状态色不唯一依赖颜色 |
| UI-02 | 手工 | 窄侧栏 + 长目录名 | 目录名省略；不遮挡 Agent 切换器 |
| UI-03 | 手工 | 中文/emoji/超长标题 | 不破版；截断合理 |
| UI-04 | 自动 | 1000 会话、20 目录 | 首屏可交互；分页有效 |
| UI-05 | 自动 | 两个 Agent 后台刷新 | 不阻塞 UI；当前 AgentView 不被切换；状态最终一致 |
| UI-06 | 自动 | 缓存大小 | 不含 transcript 全文；大小可控 |
| SEC-01 | 自动 | 标题/路径含 ANSI/OSC | 清理；不执行终端控制序列 |
| SEC-02 | 自动 | cwd/标题含 `$()`、反引号、引号 | 命令安全引用；不执行注入 |
| SEC-04 | 自动 | 日志/缓存 | 不记录完整对话、密钥、token |
| SEC-05 | 手工 | 无权限目录 | 不提升权限、不反复重试 |

---

## 14. 真实冒烟（REG）

发布前必须执行，使用真实 Herdr 和真实 Agent 数据；测试后不修改会话内容。

| ID | 类型 | 场景 | 期望 |
|---|---|---|---|
| REG-01 | 手工 | 安装后打开侧栏 | 两个 Agent 均有数据时，切换两个 Agent 分别按 cwd 展示 |
| REG-02 | 手工 | Claude 会话预览 + 恢复 | 正确 cwd；恢复同一 session |
| REG-03 | 手工 | Codex 会话预览 + 恢复 | 正确 cwd；不重复启动 |
| REG-05 | 手工 | 同一 cwd 下两 Agent 各有会话 | 切换两个 Agent，每次只显示当前 Agent 的目录/会话；不混排 |
| REG-06 | 手工 | 已有运行实例时双击 | 定位已有 tab；不新建 |
| REG-07 | 手工 | 关闭/重启 Herdr | 状态重建；缓存可用；无重复 tab |
| REG-08 | 手工 | 目录被删除后打开 | 历史可见；恢复禁用；提示明确 |
| REG-09 | 手工 | 快速连续点击/双击 | 无重复 tab/resume |
| REG-10 | 手工 | `herdr-app check` + `npm test` | 全部通过；记录版本与环境 |

---

## 15. 功能追踪

| 产品功能 | 覆盖用例 |
|---|---|
| F-01 统一同步 | SYNC-01..15, CL-01, CX-01 |
| F-02 cwd 分组 | DIR-01..28 |
| F-03 Agent 切换 | LST-03..05, LST-19..25 |
| F-04 会话列表 | LST-01..18, LST-26..28, UI-01..05 |
| F-05 预览 | PRV-01..12 |
| F-06 恢复 | OPN-01..16, REG-02..03 |
| F-07 状态显示 | MAT-01..18 |
| F-08 去重/定位 | OPN-06..10, MAT-04..09, MUL-06 |
| F-09 部分失败降级 | SYNC-02..03, SYNC-09, ERR-01..09 |
| F-10 缓存 | SYNC-04..07, SYNC-15, ERR-04 |
| F-11 无 cwd/缺目录 | DIR-07..08, DIR-13..14, DIR-21, OPN-04 |
| F-12 标签 | TAB-01..09 |
| F-13 分页 | LST-08..10 |
| F-14 归档/子代理 | DIR-17..19, LST-18 |
| F-15 搜索（P1） | 待设计 |
| F-16 目录树（P1） | 待设计 |
| F-17 多实例 | MAT-16, MUL-06 |
| F-18 tab 标题 | TAB-03..04, TAB-09 |
| F-19 热重载 | INST-08, TAB-08, REG-07 |
| F-20 窄侧栏 | LST-12, UI-02..03 |

---

## 16. 自动化补测建议

优先级从高到低：

1. **先补纯函数**：cwd 规范化、目录分组、去重、过滤、分页、状态标签。这些不依赖真实 Agent，最容易稳定回归。
2. **再补适配器 fixture**：Claude JSONL、fake Codex app-server、临时 fixture。每个适配器至少覆盖“正常、空、坏、缺字段、cwd null”。
3. **再补 helper CLI**：sync 部分失败、缓存 schema、0600、并发。
4. **最后补 Herdr 交互**：标签优先级、恢复命令、精确 space 匹配、重复点击锁。能用纯函数测的不要放到 GUI。
5. **真实冒烟只保留少量**：每个 Agent 一条预览 + 一条恢复 + 一次重启重建。

建议每个 PR 的最小回归集：

```sh
npm test
node --test test/normalize.test.mjs test/directory-view.test.mjs \
  test/adapters-claude.test.mjs test/adapters-codex.test.mjs \
```
