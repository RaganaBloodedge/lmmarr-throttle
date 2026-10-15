#!/usr/bin/env node
// session-stats —— 把「这次会话到底把 token 花在哪了」算清楚的执行器。
//
// 为什么预置它：同类的分析脚本在真实项目里被**手写过四次**，每次都是几十行内联代码进历史、
// 再被重发几十次。这是 L1「执行器」这一层最典型的收益：固化成一个文件后，调用变成一行，输出只有结论。
//
// 数据源（WorkBuddy 会话落盘格式，2026-10 实测）：
//   ~/.workbuddy/projects/<project>/<sessionId>.jsonl     一行一条事件，append-only
//   事件类型：message / reasoning / function_call / function_call_result / file-history-snapshot / session-meta
//   function_call 上带 providerData.messageId 与 message.usage{input_tokens,output_tokens,...}
//     —— 一次模型调用会拆成多条条目，每条带同一份 usage，所以必须按 messageId 去重。
//
// 输出：成功 = OK/KEY/DETAIL（≤10 行）；失败 = FAIL/FIX + 全量原始信息。
//
// 用法：
//   node session-stats.mjs <session.jsonl> [--top 5] [--detail <路径>] [--json]

import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { fail, failUsage, ok } from '../../scripts/protocol.js';

const UQ = /<user_query>([\s\S]*?)<\/user_query>/;
const UQ_ALL = /<user_query>([\s\S]*?)<\/user_query>/g;

/** 把任意 content/output 结构里的文本抽出来（与用户原脚本口径一致）。 */
function walk(node, out) {
  if (node === null || node === undefined) return;
  if (typeof node === 'string') {
    out.push(node);
    return;
  }
  if (Array.isArray(node)) {
    for (const x of node) walk(x, out);
    return;
  }
  if (typeof node === 'object') {
    const t = node.type;
    if (t === 'image' || t === 'input_image' || t === 'image_url') {
      let src = node.image_url ?? node.source ?? '';
      if (src && typeof src === 'object') src = src.data ?? src.url ?? '';
      out.push(`\u0000IMG${String(src).length}`);
      return;
    }
    if (typeof node.text === 'string') out.push(node.text);
    if (node.content !== undefined) walk(node.content, out);
    if (node.output !== undefined) walk(node.output, out);
  }
}

function textOf(node) {
  const out = [];
  walk(node, out);
  let img = 0;
  const keep = [];
  for (const s of out) {
    if (s.startsWith('\u0000IMG')) img += Number(s.slice(4)) || 0;
    else keep.push(s);
  }
  return { text: keep.join('\n'), img };
}

function parseArgs(args) {
  const flags = {};
  const pos = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--json') flags.json = true;
    else if (a === '--top') flags.top = Number(args[++i]) || 5;
    else if (a === '--detail') flags.detail = args[++i];
    else if (a.startsWith('--')) flags[a.slice(2)] = true;
    else pos.push(a);
  }
  return { pos, flags };
}

const { pos, flags } = parseArgs(process.argv.slice(2));
const target = pos[0];

if (!target) {
  failUsage(
    'session-stats 需要 <session.jsonl>',
    '会话文件在 <宿主>/.workbuddy/projects/<project>/<sessionId>.jsonl',
    '用法：node session-stats.mjs <session.jsonl> [--top 5] [--detail <路径>] [--json]',
  );
}
if (!existsSync(target)) {
  fail(`会话文件不存在: ${target}`, '确认路径；WorkBuddy 的会话在 ~/.workbuddy/projects/<project>/ 下');
}

const TOP = flags.top ?? 5;

// ---------- 扫描 ----------

const byType = new Map(); // type -> {n, bytes}
const toolCalls = new Map(); // name -> {n, argChars}
const toolResults = new Map(); // name -> {n, resChars, maxRes}
const usage = new Map(); // messageId -> {in,out,total,cacheRead,cacheCreate,model}
const topResults = [];

let turns = 0;
let realUserChars = 0;
let injectedChars = 0;
let reasoningChars = 0;
let assistantChars = 0;
let badLines = 0;
let totalLines = 0;

function bump(map, key, field, delta, init) {
  let cur = map.get(key);
  if (!cur) {
    cur = { n: 0, ...init };
    map.set(key, cur);
  }
  if (field === 'n') cur.n += delta;
  else cur[field] = (cur[field] ?? 0) + delta;
  return cur;
}

const rl = createInterface({ input: createReadStream(target, 'utf8'), crlfDelay: Infinity });

for await (const line of rl) {
  totalLines += 1;
  const s = line.trim();
  if (!s) continue;
  let o;
  try {
    o = JSON.parse(s);
  } catch {
    badLines += 1;
    continue;
  }
  const t = o.type ?? 'unknown';
  bump(byType, t, 'n', 1, { bytes: 0 });
  byType.get(t).bytes += Buffer.byteLength(s, 'utf8');

  if (t === 'message') {
    const { text } = textOf(o.content);
    if (o.role === 'user') {
      const all = text.match(UQ_ALL) ?? [];
      if (all.length) turns += 1;
      const real = all.map((x) => UQ.exec(x)?.[1] ?? '').join('\n');
      realUserChars += real.length;
      injectedChars += Math.max(0, text.length - real.length);
    } else {
      assistantChars += text.length;
    }
  } else if (t === 'reasoning') {
    const a = textOf(o.rawContent);
    const b = a.text.trim() ? a : textOf(o.content);
    reasoningChars += b.text.length;
  } else if (t === 'function_call') {
    const name = o.name ?? '?';
    const argChars = String(o.arguments ?? '').length;
    bump(toolCalls, name, 'n', 1, { argChars: 0 });
    toolCalls.get(name).argChars += argChars;

    const pd = o.providerData ?? {};
    const mid = pd.messageId;
    const u = o.message?.usage;
    if (mid && u && !usage.has(mid)) {
      usage.set(mid, {
        in: Number(u.input_tokens ?? 0),
        out: Number(u.output_tokens ?? 0),
        total: Number(u.total_tokens ?? 0),
        cacheRead: Number(u.cache_read_input_tokens ?? 0),
        cacheCreate: Number(u.cache_creation_input_tokens ?? 0),
        model: pd.requestModelName ?? pd.model ?? '?',
      });
    }
  } else if (t === 'function_call_result') {
    const name = o.name ?? '?';
    const { text } = textOf(o.output);
    bump(toolResults, name, 'n', 1, { resChars: 0, maxRes: 0 });
    const r = toolResults.get(name);
    r.resChars += text.length;
    if (text.length > r.maxRes) r.maxRes = text.length;
    topResults.push({ chars: text.length, name, head: text.slice(0, 120).replace(/\s+/g, ' ') });
  }
}

// ---------- 汇总 ----------

const calls = [...usage.values()];
const sumIn = calls.reduce((a, u) => a + u.in, 0);
const sumOut = calls.reduce((a, u) => a + u.out, 0);
const sumCacheRead = calls.reduce((a, u) => a + u.cacheRead, 0);
const ins = calls.map((u) => u.in).sort((a, b) => a - b);
const baseFix = ins.length ? ins[0] : 0;
const fixedTotal = baseFix * calls.length;
const resend = sumIn > 0 ? (sumIn - fixedTotal) / sumIn : 0;
const cacheRatio = sumIn > 0 ? sumCacheRead / sumIn : 0;

const toolRank = [...new Set([...toolCalls.keys(), ...toolResults.keys()])].sort(
  (a, b) =>
    (toolCalls.get(b)?.n ?? 0) + (toolResults.get(b)?.n ?? 0) - ((toolCalls.get(a)?.n ?? 0) + (toolResults.get(a)?.n ?? 0)),
);
topResults.sort((a, b) => b.chars - a.chars);

const detail = {
  session: target,
  fileBytes: statSync(target).size,
  lines: totalLines,
  badLines,
  turns,
  modelCalls: calls.length,
  tokens: {
    input: sumIn,
    output: sumOut,
    cacheRead: sumCacheRead,
    inputMin: ins[0] ?? 0,
    inputMedian: ins.length ? ins[Math.floor(ins.length / 2)] : 0,
    inputMax: ins.length ? ins[ins.length - 1] : 0,
    fixedOverhead: fixedTotal,
    historyResend: sumIn - fixedTotal,
  },
  chars: { realUser: realUserChars, injected: injectedChars, reasoning: reasoningChars, assistant: assistantChars },
  byType: Object.fromEntries([...byType].map(([k, v]) => [k, { n: v.n, bytes: v.bytes }])),
  tools: Object.fromEntries(
    [...new Set([...toolCalls.keys(), ...toolResults.keys()])]
      .sort()
      .map((n) => [
        n,
        {
          calls: toolCalls.get(n)?.n ?? 0,
          argChars: toolCalls.get(n)?.argChars ?? 0,
          results: toolResults.get(n)?.n ?? 0,
          resChars: toolResults.get(n)?.resChars ?? 0,
          maxResult: toolResults.get(n)?.maxRes ?? 0,
        },
      ]),
  ),
  topResults: topResults.slice(0, 12),
  models: calls.reduce((acc, u) => {
    acc[u.model] = (acc[u.model] ?? 0) + 1;
    return acc;
  }, {}),
};

// ---------- 输出 ----------

if (flags.json) {
  process.stdout.write(JSON.stringify({ ok: true, summary: { turns, calls: calls.length, input: sumIn, output: sumOut, resend, cacheRatio }, detail }, null, 2) + '\n');
  process.exit(0);
}

if (!calls.length) {
  fail(
    '没读到任何带 usage 的模型调用',
    '确认这是宿主会话的 .jsonl（而非工具结果副本或空会话）',
    `扫描 ${totalLines} 行，解析失败 ${badLines} 行`,
  );
}

const top = toolRank.slice(0, TOP).map((n) => `${n}:${toolCalls.get(n)?.n ?? 0}`).join(',');
const biggest = topResults[0];

const detailPath =
  flags.detail ??
  join(tmpdir(), 'lmmarr-throttle', `session-stats-${createHash('sha1').update(String(target)).digest('hex').slice(0, 8)}.json`);
mkdirSync(dirname(detailPath), { recursive: true });
writeFileSync(detailPath, JSON.stringify(detail, null, 2), 'utf8');

ok(
  `${turns} 轮 · ${calls.length} 次模型调用 · 输入 ${sumIn.toLocaleString()} tok`,
  {
    session: basename(target),
    lines: totalLines,
    input: sumIn.toLocaleString(),
    output: sumOut.toLocaleString(),
    'cache-read': sumCacheRead ? `${(cacheRatio * 100).toFixed(1)}%` : 'n/a',
    'resend(历史重发)': `${(resend * 100).toFixed(1)}%`,
    'top-tools': top,
    biggest: biggest ? `${biggest.name}:${biggest.chars}` : 'n/a',
  },
  detailPath,
);
