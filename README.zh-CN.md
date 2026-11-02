# Herdr Codex 侧栏 Mod

[English](README.md) | 简体中文

一个用于浏览 Codex 项目和对话、恢复已有 thread，并将历史与 Herdr 实时
Agents 视图分离的 Herdr mod。已关联项目中的 thread 会从项目根目录恢复，
即使它最初是在另一个目录创建的。

## 使用

- 单击对话：打开带标题的 tab，并输出只读的历史预览，不启动 Codex。
- 双击对话：在同一个 tab 中恢复对应的 Codex thread。
- Codex 会话中按下 Ctrl+C 后会返回该 tab 的 shell，tab 不会被关闭。
- 已在运行的对话会直接聚焦，不会重复启动。
- 新会话的 tab 名会立即跟随推断出的 thread。Herdr 中显示的实时 Agent 标题
  仍由 Codex 自己的终端标题更新决定。

## 安装

要求：Node.js 20+、Codex CLI 和 Herdr App。

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
`~/.config/herdr-app/data/herdr-codex-sidebar-mod`，不属于 mod 本身。

如果 Herdr 使用自定义 home，安装时需要设置相同的环境变量：

```sh
HERDR_APP_HOME=/path/to/herdr-app npm run sync:herdr
```

安装后的 mod 通过 Herdr 的 `appHome()` 定位所有相关路径，不包含开发者本机的
绝对路径。wrapper 会从用户环境中查找 Node、`codex` 和 `hc`，并为常见的
macOS/Linux 安装位置提供回退。该 mod 目前面向 POSIX 系统，并要求用户终端
环境中的 `codex` 命令可用。

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
