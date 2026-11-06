# Herdr Agent History 侧栏 Mod

[English](README.md) | 简体中文

一个在 Herdr 中按 Agent（Claude Code / Codex）和真实工作目录
浏览、预览、恢复历史会话的 mod。侧栏一次只显示一个 Agent，通过右上角
切换器在两者之间切换；每个 Agent 内按会话的真实 `cwd` 精确分组，不使用
Codex project/assignment 或 Claude 编码目录名。

## 使用

- 右上角 Agent 切换器：Claude / Codex 二选一，没有 All，不混排。
- 单击对话：打开带标题的 tab，输出只读历史预览，不启动任何 Agent。
- 双击对话：在正确 cwd 中恢复对应 Agent 的会话。
- 已在运行的会话会直接聚焦，不会重复启动。
- Agent 退出后，预览/占位 tab 仍可在原 tab 中继续恢复。
- 目录按真实 cwd 精确分组；目录不存在或无权限时，历史仍可预览，但恢复
  会禁用并说明原因，不会静默回退到 home。

## 安装

要求：Node.js 20+、Herdr App，以及至少一个已安装的 Agent（Claude Code /
Codex）。

```sh
git clone git@github.com:naFeKnehC/herdr-codex-sidebar-mod.git
cd herdr-codex-sidebar-mod
npm run sync:herdr
herdr-app check ~/.config/herdr-app/mods/herdr-codex-sidebar-mod
```

源码中的 mod 目录是自包含的，包含自己的 helper 和命令 wrapper。
`sync:herdr` 会把该目录复制到
`~/.config/herdr-app/mods/herdr-codex-sidebar-mod`，因此直接复制该目录也可以
运行。helper 缓存位于
`~/.config/herdr-app/data/herdr-agent-history/history.json`，不属于 mod 本身。

如果 Herdr 使用自定义 home，安装时需要设置相同的环境变量：

```sh
HERDR_APP_HOME=/path/to/herdr-app npm run sync:herdr
```

安装后的 mod 通过 Herdr 的 `appHome()` 定位所有相关路径，不包含开发者本机的
绝对路径。wrapper 会从用户环境中查找 Node、`codex` 和 `hc`，并为常见的
macOS/Linux 安装位置提供回退。该 mod 目前面向 POSIX 系统，并要求用户终端
环境中的 `codex` 命令可用。

## 文档

- [产品功能文档](docs/PRODUCT.zh-CN.md)：目标功能、交互规则、状态模型和当前差距。
- [测试文档](docs/TEST.zh-CN.md)：完整验收矩阵、自动化覆盖情况和发布门槛。

## 开发

```sh
npm test
npm run sync:herdr
```

`sync:herdr` 不会复制缓存文件、Codex transcript 或 Herdr 自动生成的声明文件。

修改源码后，运行 `npm run sync:herdr` 并重新加载 Herdr mod（或重启 Herdr）
以加载新代码。

## 目录结构

- `mods/herdr-codex-sidebar-mod/`：自包含的 Herdr UI mod、helper 和 wrapper。
- `scripts/`：安装脚本。
- `test/`：数据标准化和实时会话匹配的单元测试。

## 许可证

MIT。详见 `LICENSE`。
