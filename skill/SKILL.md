---
name: lmmarr-throttle
description: 会话内上下文节流与冷存重建。当一次长程任务把上下文撑大、历史对话被反复重发、工具返回结果越积越多且很快失真时使用；也用于把「做过什么 / 踩过哪些坑 / 还没解决什么」沉淀成可跨会话复用的冷存储，或用一段 brief 替代重读历史。触发场景：同一个话题跨多轮继续、上下文逼近上限、想在开工前回想这个任务之前的决策与坑、想量一下 token 到底花在哪。短程一次性任务不适用。
agent_created: true
---

# lmmarr-throttle 上下文节流

## 它解决什么问题

长程任务里，**每一轮都要把上文再发一遍**，而这笔钱绝大部分花在很快失效的东西上：
工具返回的原文、中间过程、已经解决的报错、对下一步没帮助的思考。

本 skill 的主张一句话：

> **主上下文只装「结论 + 指针」。** 过程、原文、失败重试——要么**不进**（子代理），
> 要么**压掉**（执行器），要么**可回收**（冷存储 journal）。

**短程任务不要启用它。** 它面向长程：同一模式出现第二次、上下文逼近上限、任务已跨多轮。

## 能力分层

```
L4 委派   大探索走子代理      → 过程永不进主上下文（50k in / 1.5k out）
L3 沉淀   journal + brief     → 让「删」变安全
L2 纪律   grep / limit / 并行 → 每轮体积 ×0.86、消除重复读
L1 执行器 固化成脚本，一行调用  → 转数 ×0.6（第一杠杆，收益最大）
```

## 工作流

### 一、开工前：读 brief，不要重读历史

```bash
node <skill-dir>/scripts/cli.js brief .workbuddy/memory <task-id> [关键词...]
```

拼出一段 ≤1200 字符的指引（目标 / 已定决策 / 相关坑 / 未解决 / 下一步 / 文件指针），
**零 LLM 调用**。细节回冷存储按指针取，不要整份读回。

### 二、过程中：只沉淀「指令 + 结果」

```bash
node <skill-dir>/scripts/cli.js journal .workbuddy/memory <task-id> add did  "改某处加重复惩罚 → 5 条断言通过"
node <skill-dir>/scripts/cli.js journal .workbuddy/memory <task-id> add pit  "中文 PDF 文本层按列倒序 → 提取失败；特征=单字碎片；处理=放弃不重试"
node <skill-dir>/scripts/cli.js journal .workbuddy/memory <task-id> add open "smoke_test 第 3 例 flaky（复现：连跑 5 次 1 次失败）"
node <skill-dir>/scripts/cli.js journal .workbuddy/memory <task-id> next "补第 4 例"
```

**写不进去是设计的一部分**：条目必须单行、≤400 字符。
长串输出、代码块、diff 原文一律不进 —— 留个指针就够了。

### 三、报错解决了：降级，并丢掉原文

```bash
node <skill-dir>/scripts/cli.js journal .workbuddy/memory <task-id> resolve 9 --keep "特征=偶发超时；处理=超时调到 30s"
```

`open #9` 变成 `pit #9`，**报错原文被丢弃**。这是一次真正的总结动作，不是复制粘贴。

### 四、探索性工作：先探测能力，再决定路线

```bash
node <skill-dir>/tools/agents-probe.mjs    # 第一行 OK agents=yes|no，最后一行 MODE
```

- `MODE delegate` → 把探索**委派**给子代理，只让结论回主流程；brief 必须自包含，
  返回契约里钉死"不要回贴原文与中间过程"。
- `MODE self-compress` → 探索**完成时只留结果与关键节点**，不留过程；
  先 grep 定位再带 limit 读；答完即登记，此后不再引用原文。

细节见 `references/capability-gate.md`。

### 五、想知道 token 花在哪

```bash
node <skill-dir>/tools/exec/session-stats.mjs <session.jsonl>
```

给出转数 / 输入输出 token / 缓存命中 / **历史重发占比** / 工具分布，成功只回 ~10 行，
明细写进 `DETAIL` 指向的文件。**改了什么之后，用它复量，而不是凭感觉。**

## 纪律（要点）

- **绝不动已缓存的前缀。** 只对"今后新产生的内容"节流；改写历史前缀会把便宜的缓存命中
  变成全价重读，**成本反而上升**。
- **成功压 ~10 行，失败吐全量。** 压缩只在成功态有收益；失败态压掉的是调试信息。
- **绝不静默截断。** 丢东西必须说出来。
- **读回来的东西不要写回记忆。**
- **绝不在同一轮同时用 brief 和整份 journal。** 那就没有节流。

完整版见 `references/discipline.md`。

## 边界

本 skill 管**入口**（不让过程进来、把结论沉淀成指针），管不了**窗口里**
（让已经进入的旧观测消失）。后者需要框架层的掩码 / hook。
准确说法：**skill 管入口，框架管窗口。**

## 命令速查

| 命令 | 作用 |
|---|---|
| `cli.js brief <dir> <taskId> [关键词]` | 从冷存储重拼一段指引（零 LLM） |
| `cli.js journal <dir> <taskId> add <did\|pit\|open> <文本>` | 追加一条「指令 + 结果」 |
| `cli.js journal <dir> <taskId> resolve <序号> --keep <文本>` | 报错已解决：降级并丢弃原文 |
| `cli.js journal <dir> <taskId> next <文本>` | 设置「下一步」（覆盖） |
| `cli.js journal <dir> <taskId> show` | 打印该任务的 journal 正文 |
| `tools/agents-probe.mjs` | 探测有无子代理 → `MODE` |
| `tools/exec/session-stats.mjs <jsonl>` | 会话 token / 转数 / 缓存 / 工具分布 |

## 资源

- `references/journal-format.md` —— journal 文件格式、四类条目、报错生命周期
- `references/brief.md` —— brief 的结构、关键词选择、预算与截断
- `references/capability-gate.md` —— 能力门与两条探索路线
- `references/protocol.md` —— 执行器输出协议，以及怎么写新执行器
- `references/discipline.md` —— 三条杠杆、三条红线、委派契约、触发条件
- `scripts/` —— 执行层（零依赖，Node 22+）；**本 skill 零构建，scripts 里的 JS 就是源码**

## 与 lmmarr-memory 的关系

两套**共用同一份冷存储**（`.workbuddy/memory/`），不抢目录：

| | 回答 | 谁 |
|---|---|---|
| `MEMORY_<id>.md` + `MEMORY.md` | 跨会话：有哪些任务、彼此什么关系、各自到哪了 | `lmmarr-memory` |
| `JOURNAL_<id>.md` | 会话内：这个任务上发生过什么（指令 + 结果） | **本 skill** |

两者可以只用其一。同时用时，先 `brief` 再干活，干完往 `journal` 里追加。
