// session-audit —— 量「本会话的钱花在哪、其中多少是本 skill 能碰到的」。
//
// 为什么预置它：同类分析脚本在 RPGBar 与 LongMemoryPlugin 两个项目里已经被**手写四次**
// （token_usage_analysis / history_resend_analysis / tool_result_audit / 一次性 lmt-audit）。
// 每次都是几十行内联代码进历史、再被重发几百次 —— 这正是 L1「执行器」层最典型的收益：
// 固化成文件后，调用是一行，输出只有结论。
//
// 与 session-stats 的分工：session-stats 报「花了多少」（症状）；
// session-audit 报「其中多少是可省的、省在哪」（处方）。后者才是改完之后要复量的那个数。
//
// 口径（关键：不依赖 chars→token 的汇率假设，全部用**正比关系**表达）
//   内容在第 k 次调用进入历史 → 被其后 (N-k) 次调用各重发一次 ⇒ 权重 W = N-k
//   Σ chars×W 正比于名义输入总量 ⇒ 份额 = 该项的 Σchars×W / 全部 Σchars×W
//   换算成 token：tok = 名义输入 × 份额（不引入 3.5 字符/token 这类猜测）
//
// 已知偏差（如实写在输出里，不藏）：重复读与大读截断可能命中同一条读数 ⇒ 合计是**上界**。
//
// 只依赖 node 内置模块。
import { createHash } from 'node:crypto';
import { readFileSync, statSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fail, failUsage, ok } from '../../scripts/protocol.js';

// ---------- 常量（可被 --read-cap / --result-cap / --top 覆盖） ----------

const READ_CAP_DEFAULT = 8000;   // 一次 Read 的合理体积上限（≈200 行）
const RESULT_CAP_DEFAULT = 600;  // 执行器协议下成功回执的体量（~10 行）
const ARG_CAP_DEFAULT = 120;     // 一行命令的参数量级
const TOP_DEFAULT = 6;

// ---------- 用法 ----------

function usageText() {
  return [
    '用法: node session-audit.mjs <会话.jsonl> [--top N] [--read-cap 字符] [--result-cap 字符] [--json] [--detail 路径]',
    '',
    '  --top        列出多少个「进历史最多」的工具（默认 6）',
    '  --read-cap   一次 Read 的体积上限，默认 8000 字符',
    '  --result-cap 执行器成功回执的体量上限，默认 600 字符',
    '  --json       输出结构化结果而不是协议回执',
    '  --detail     明细文件路径，默认落系统临时目录',
    '',
    '退出码: 0 成功 / 1 读不了或没有 usage / 2 用法错误',
  ].join('\n');
}

// ---------- 参数 ----------

const argv = process.argv.slice(2);
const flags = { json: false, detail: null, top: TOP_DEFAULT, readCap: READ_CAP_DEFAULT, resultCap: RESULT_CAP_DEFAULT };
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--json') flags.json = true;
  else if (a === '--detail') flags.detail = argv[++i];
  else if (a === '--top') flags.top = Number(argv[++i]);
  else if (a === '--read-cap') flags.readCap = Number(argv[++i]);
  else if (a === '--result-cap') flags.resultCap = Number(argv[++i]);
  else if (a === '--help' || a === '-h') {
    process.stdout.write(usageText() + '\n');
    process.exit(0);
  } else if (a.startsWith('-')) failUsage(`未知参数 ${a}`, '看 --help', usageText());
  else positional.push(a);
}

if (positional.length !== 1) failUsage('需要且只需要一个会话文件路径', 'node session-audit.mjs <会话.jsonl>', usageText());
const target = positional[0];
if (!existsSync(target)) {
  fail('会话文件不存在', '确认路径；宿主会话一般落在 <数据目录>/projects/<项目>/<sessionId>.jsonl', target);
}

// ---------- 扫描 ----------

const UQ_ALL = /<user_query>([\s\S]*?)<\/user_query>/g;
const textOf = (c) =>
  c == null ? '' : typeof c === 'string' ? c : Array.isArray(c) ? c.map(textOf).join('') : typeof c === 'object' ? textOf(c.text ?? c.content ?? '') : '';

const items = [];              // {name, args, chars, k}
const midIndex = new Map();
const byCallId = new Map();
const usage = new Map();
let turn = 0;
let badLines = 0;
let lines = 0;
let fcWithoutUsage = 0;

for (const raw of readFileSync(target, 'utf8').split('\n')) {
  lines += 1;
  const s = raw.trim();
  if (!s) continue;
  let o;
  try {
    o = JSON.parse(s);
  } catch {
    badLines += 1;
    continue;
  }
  if (o.type === 'message' && o.role === 'user') {
    if ((textOf(o.content).match(UQ_ALL) || []).length) turn += 1;
    continue;
  }
  if (o.type !== 'function_call' && o.type !== 'function_call_result') continue;

  const pd = o.providerData ?? {};
  const mid = pd.messageId;

  if (o.type === 'function_call') {
    if (mid && !midIndex.has(mid)) midIndex.set(mid, midIndex.size);
    // usage 不一定挂在同一个 messageId 的首个事件上 → 取首个「带 usage」的
    const u = o.message?.usage;
    if (u) {
      if (mid && !usage.has(mid)) usage.set(mid, { in: Number(u.input_tokens ?? 0), out: Number(u.output_tokens ?? 0), cacheRead: Number(u.cache_read_input_tokens ?? 0) });
    } else fcWithoutUsage += 1;

    const rec = { name: o.name ?? '?', args: String(o.arguments ?? ''), chars: 0, k: mid ? midIndex.get(mid) : -1 };
    if (o.callId) byCallId.set(o.callId, rec);
    items.push(rec);
  } else {
    const chars = textOf(o.output).length;
    const rec = o.callId ? byCallId.get(o.callId) : null;
    if (rec) rec.chars = chars;
    else items.push({ name: o.name ?? '?', args: '', chars, k: -1, orphan: true });
  }
}

const N = midIndex.size;
if (!usage.size) {
  fail('没读到任何带 usage 的模型调用', '确认这是宿主会话的 .jsonl（而不是工具结果副本或空会话）', `扫描 ${lines} 行，解析失败 ${badLines} 行`);
}

// 权重 = 它之后还有多少次调用。条目由第 k 次调用产出，进上下文的是 k+1 … N-1 这 N-1-k 次。
const W = (k) => (k < 0 || k >= N ? 0 : N - k - 1);
const sumIn = [...usage.values()].reduce((a, u) => a + u.in, 0);
const sumOut = [...usage.values()].reduce((a, u) => a + u.out, 0);
const sumCache = [...usage.values()].reduce((a, u) => a + u.cacheRead, 0);
const effective = Math.round(sumCache * 0.1 + (sumIn - sumCache));

let inflow = 0;
let totalW = 0;
const perTool = new Map();
for (const it of items) {
  const w = it.chars * W(it.k);
  inflow += it.chars;
  totalW += w;
  const c = perTool.get(it.name) ?? { n: 0, chars: 0, w: 0, max: 0 };
  c.n += 1;
  c.chars += it.chars;
  c.w += w;
  if (it.chars > c.max) c.max = it.chars;
  perTool.set(it.name, c);
}

const parse = (it) => {
  try {
    return JSON.parse(it.args);
  } catch {
    return null;
  }
};
const share = (w) => (totalW ? (w / totalW) * 100 : 0);
const toks = (w) => (totalW ? Math.round((sumIn * w) / totalW) : 0);

// Read 纪律
const reads = items.filter((it) => it.name === 'Read' && it.chars > 0);
const limited = reads.filter((it) => (parse(it) ?? {}).limit != null);
const avgOf = (a) => (a.length ? Math.round(a.reduce((s, x) => s + x.chars, 0) / a.length) : 0);

// 重复读
const byPath = new Map();
for (const it of reads) {
  const p = (parse(it) ?? {}).file_path ?? '?';
  byPath.set(p, (byPath.get(p) ?? 0) + 1);
}
const dupPaths = [...byPath].filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1]);
const seen = new Set();
let dupW = 0;
for (const it of reads) {
  const p = (parse(it) ?? {}).file_path ?? '?';
  if ((byPath.get(p) ?? 0) <= 1) continue;
  if (seen.has(p)) dupW += it.chars * W(it.k);
  else seen.add(p);
}

// 大读截断
let capW = 0;
for (const it of reads) capW += Math.max(0, it.chars - flags.readCap) * W(it.k);

// 执行器：多行/内联脚本 → 一行调用 + ~10 行输出
const INLINE = /<<\s*['"]?\w+|python\s+-(?:c|<<)|node\s+(?:-e|--eval)|py\s+-(?:c|<<)/;
const execItems = items.filter((it) => it.name === 'Bash' && (() => {
  const cmd = (parse(it) ?? {}).command ?? '';
  return cmd.includes('\n') || INLINE.test(cmd);
})());
let execW = 0;
for (const it of execItems) {
  execW += Math.max(0, it.chars - flags.resultCap) * W(it.k);
  execW += Math.max(0, it.args.length - ARG_CAP_DEFAULT) * W(it.k);
}

const ranked = [...perTool].sort((a, b) => b[1].w - a[1].w);
const addressable = capW + dupW + execW;

// ---------- 输出 ----------

const detail = {
  session: target,
  fileBytes: statSync(target).size,
  lines,
  badLines,
  turns: turn,
  modelCalls: N,
  functionCallsWithoutUsage: fcWithoutUsage,
  tokens: { input: sumIn, output: sumOut, cacheRead: sumCache, perCall: Math.round(sumIn / (N || 1)) },
  effectiveCostAt01x: effective,
  chars: { toolResultsInflow: inflow, resendWeightedTotal: totalW },
  byTool: Object.fromEntries([...perTool].map(([k, v]) => [k, { calls: v.n, chars: v.chars, maxChars: v.max, sharePct: +share(v.w).toFixed(1) }])),
  reads: {
    total: reads.length,
    withLimit: limited.length,
    avgChars: avgOf(reads),
    avgCharsWithLimit: avgOf(limited),
    capAssumed: flags.readCap,
  },
  duplicateReads: { paths: dupPaths.map(([p, n]) => ({ path: p, n })), redundantSharePct: +share(dupW).toFixed(1) },
  addressable: {
    duplicateReadsPct: +share(dupW).toFixed(1),
    oversizedReadsPct: +share(capW).toFixed(1),
    inlineScriptsPct: +share(execW).toFixed(1),
    upperBoundPct: +share(addressable).toFixed(1),
    upperBoundTokens: toks(addressable),
  },
};

if (flags.json) {
  process.stdout.write(JSON.stringify({ ok: true, summary: { turns: turn, calls: N, input: sumIn, addressablePct: detail.addressable.upperBoundPct }, detail }, null, 2) + '\n');
  process.exit(0);
}

const detailPath =
  flags.detail ?? join(tmpdir(), 'lmmarr-throttle', `session-audit-${createHash('sha1').update(String(target)).digest('hex').slice(0, 8)}.json`);
mkdirSync(dirname(detailPath), { recursive: true });
writeFileSync(detailPath, JSON.stringify(detail, null, 2), 'utf8');

const topStr = ranked.slice(0, 3).map(([n, c]) => `${n} ${share(c.w).toFixed(1)}%`).join(' · ');
const dupStr = dupPaths.slice(0, 3).map(([p, n]) => `${String(p).split(/[\\/]/).pop()}×${n}`).join(' ');

ok(
  `${turn} 轮 · ${N} 次调用 · 名义输入 ${sumIn.toLocaleString()} · 平均 ${Math.round(sumIn / (N || 1)).toLocaleString()}/次`,
  {
    effective: `缓存 ${((sumCache / (sumIn || 1)) * 100).toFixed(1)}% ⇒ 等效 ${effective.toLocaleString()}（0.1x）`,
    inflow: `${inflow.toLocaleString()} 字符 ⇒ 重发权重集中在 ${topStr}`,
    'read-discipline': `${reads.length} 次 ｜ 带 limit ${((limited.length / (reads.length || 1)) * 100).toFixed(0)}% ｜ 单条最大 ${Math.max(0, ...reads.map((r) => r.chars)).toLocaleString()}`,
    addressable: `上界 ${share(addressable).toFixed(1)}%（≈${toks(addressable).toLocaleString()} tok）＝ 重复读 ${share(dupW).toFixed(1)}% + 大读截断 ${share(capW).toFixed(1)}% + 执行器 ${share(execW).toFixed(1)}%`,
    'dup-reads': `${dupPaths.length} 个路径 ${dupStr}`,
  },
  detailPath,
);
