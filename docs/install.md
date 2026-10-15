# 安装

本 skill **零构建**：`skill/` 里的 JS 既是源码也是产物，安装只有复制与核对。

## WorkBuddy

```bash
git clone https://github.com/RaganaBloodedge/lmmarr-throttle.git
cd lmmarr-throttle
npm run install:skill
```

装到 `~/.workbuddy/skills/lmmarr-throttle/`，安装后会自动跑两条自检
（`cli.js` 无参数应退出 2、`agents-probe.mjs` 应退出 0）。

核对是否与仓内一致（CI 或改完代码后跑）：

```bash
npm run verify          # 测试 + 安装核对
node dev/install-skill.mjs --check
```

装到别处：

```bash
node dev/install-skill.mjs --dest /path/to/skills/lmmarr-throttle
```

## Claude Code

skill 目录约定不同，但仍是一个目录 + 一份 `SKILL.md`：

```bash
node dev/install-skill.mjs --dest ~/.claude/skills/lmmarr-throttle
```

能力门会自动按 `.claude/` 的存在判定，无需改配置。

## 其他宿主 / 裸脚本

`scripts/` 与 `tools/` 是普通 Node 脚本，只要有 Node 22+ 就能直接跑，不依赖任何 skill 机制：

```bash
node skill/scripts/cli.js brief .workbuddy/memory <task-id>
node skill/tools/agents-probe.mjs
node skill/tools/exec/session-stats.mjs ~/.workbuddy/projects/<项目>/<会话>.jsonl
```

零运行时依赖（只用 node 内置模块），无 `node_modules`。

## 卸载

```bash
rm -rf ~/.workbuddy/skills/lmmarr-throttle
```

注意：卸载 skill **不会**动你的冷存储。`.workbuddy/memory/` 里的
`JOURNAL_*.md` 与 `MEMORY_*.md` 是数据，删之前先想清楚。
