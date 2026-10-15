# lmmarr-throttle

**会话内上下文节流**：让主上下文只装「结论 + 指针」，而不是每轮重发一遍历史。

> 配套项目：[`lmmarr-memory`](https://github.com/RaganaBloodedge/dsh-lmmarr) 管**跨会话的任务结构**；
> 本项目管**会话内的节流与重建**。两者共用同一份冷存储（`.workbuddy/memory/`），不抢目录，可以只用其一。

---

## 它治的病

长会话里，**每一轮都要把上文再发一遍**，而这笔钱绝大部分花在很快失效的东西上：
工具返回原文、中间过程、已经解决的报错、对下一步没帮助的思考。

一次真实长会话（422 轮）的账：

| 口径 | 数值 |
|---|---|
| 输入占成本 | 99.4% |
| 其中"**把上文再发一遍**"（历史重发） | **76.4%** |
| 一条内容进历史后平均被重发 | **63.8 次** |
| 读取后 2 次调用内文件被改（**快照已过期**） | **40.4%** |

**过期的东西留着不只是没用，是错的。** 口径与来源见 [`docs/cost-model.md`](docs/cost-model.md)。

---

## 一个例子

**没有它**：新会话开工前，把之前几十轮的工具返回、报错原文、思考过程重新读一遍。

**有它**：跑一条 `brief`，拿到 500 字符的指引：

```
【任务】api-retry · 支付接口重试策略  [doing 40%]
已定指数退避，待补熔断
【已定】
- #1 改用指数退避，基准 200ms
- #2 接入熔断器，阈值 50%
【坑】
- #3 熔断器默认半开窗口太短 → 误放流量；处理=调到 30s
【未决】
- #5 并发压测下 P99 抖动未定位（复现：50 并发连跑 10 分钟）
【下一步】补熔断器单测
【指针】MEMORY_api-retry.md / JOURNAL_api-retry.md（细节按需取，不要整份读回）
```

**零 LLM 调用**——纯模板 + 关键词计数，所以便宜到可以随便跑，也不引入新的失真。

---

## 快速开始

```bash
git clone https://github.com/RaganaBloodedge/lmmarr-throttle.git
cd lmmarr-throttle
npm run install:skill        # 装到 ~/.workbuddy/skills/lmmarr-throttle
```

跑起来（`<skill>` = 上一步的安装目录）：

```bash
# 1) 开工前：读 brief，不要重读历史
node <skill>/scripts/cli.js brief .workbuddy/memory api-retry 熔断

# 2) 过程中：只沉淀「指令 + 结果」
node <skill>/scripts/cli.js journal .workbuddy/memory api-retry add did  "改某处加重复惩罚 → 5 条断言通过"
node <skill>/scripts/cli.js journal .workbuddy/memory api-retry add open "smoke_test 第 3 例 flaky（复现：连跑 5 次 1 次失败）"

# 3) 报错解决了：降级，并丢掉原文
node <skill>/scripts/cli.js journal .workbuddy/memory api-retry resolve 9 --keep "特征=偶发超时；处理=超时调到 30s"

# 4) 探索前：先探测框架有没有子代理
node <skill>/tools/agents-probe.mjs          # → MODE delegate | self-compress

# 5) 想知道 token 花在哪、以及能省多少
node <skill>/tools/exec/session-stats.mjs <session.jsonl>   # 症状：花了多少
node <skill>/tools/exec/session-audit.mjs <session.jsonl>   # 处方：可省上界与三项归因
```

---

## 四层能力

```
L4 委派   大探索走子代理      → 过程永不进主上下文（50k in / 1.5k out）
L3 沉淀   journal + brief     → 让「删」变安全
L2 纪律   grep / limit / 并行 → 每轮体积 ×0.86、消除重复读
L1 执行器 固化成脚本，一行调用  → 转数 ×0.6（第一杠杆，收益最大）
```

**能力门**是 L4 的入口：探测当前 Agent 框架有没有子代理，据此分叉——
有就委派（过程物理上回不来），没有就退化为"探索完成时只留结果与关键节点"。

---

## 三条由代码强制的纪律

"不记过程、不记原文"这件事，留给纪律就会破功。所以它在代码里：

| 纪律 | 实现 |
|---|---|
| 条目必须单行 | 长串输出、代码块、diff 原文**在结构上写不进来** |
| 条目 ≤400 字符 | 超了直接报错，逼你写成「指令 + 结果」 |
| **唯一允许的改写**：`open` → `pit` | 报错解决后降级，**丢弃报错原文**；且 `resolve` 强制要求 `--keep` 写总结 |

外加执行器的**双模输出**：成功压到 ~10 行（`OK/KEY/DETAIL`），
失败吐全量 stderr + 最小复现——**压缩只在成功态有收益，失败态压掉的是调试信息**。

---

## 边界（诚实）

本 skill 管**入口**（不让过程进来、把结论沉淀成指针），管不了**窗口里**
（让已经进入的旧观测消失——那需要框架层的掩码 / hook）。

还有一条红线：**绝不动已缓存的前缀**。缓存命中率高的时候，
"回头把历史压一压再重拼"会*把最便宜的部分变成最贵的*。

展开见 [`docs/DESIGN.md`](docs/DESIGN.md)。

---

## 仓库结构

```
skill/                 ← 装到宿主的就是这个目录
  SKILL.md             skill 本体（触发条件、工作流、纪律）
  references/          格式、协议、能力门、纪律的细节
  scripts/             执行层：cli / journal / brief / taskdoc / protocol
  tools/
    agents-probe.mjs   能力门
    exec/              执行器库（session-stats 报症状；session-audit 报可省份额）
tests/                 52 条测试（node:test，无框架依赖）
dev/install-skill.mjs  安装与核对
docs/                  DESIGN / cost-model / install
```

**零构建、零运行时依赖**（只用 node 内置模块，Node 22+）。
`skill/scripts/*.js` 既是源码也是产物，不存在"源码与产物不一致"。

---

## 验证

```bash
npm test        # 52 条测试
npm run verify  # 测试 + 与已安装的 skill 逐字节核对
npm run gate    # 跑一次能力门
```

测试里值得一提的几条：
- 条目**单行 / 限长**被真的拒（且拒绝后不落盘，不留半条）
- `resolve` 之后**原报错从文件里消失**
- 非法任务 id（含 `..`）**退出码 2 且越界写被挡住**
- 执行器成功回执**恒定压 10 行内**，失败回执**原始输出整段保留**
- `taskdoc` 用 `lmmarr-memory` 真实渲染出的样本钉住格式契约，防止两边漂移

---

## 命名

| 位置 | 名字 |
|---|---|
| skill 名 / GitHub 仓库 | `lmmarr-throttle` |
| 族内定位 | lmmarr 家族的**节流侧**（`lmmarr-memory` 是记忆侧） |

## License

MIT
