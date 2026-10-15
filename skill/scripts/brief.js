// brief —— 把冷存储里的东西重拼成一段「指引性」的文本，回喂给模型。
//
// 这是用户最初那条要求的落点：
//   「很多历史对话不应该直接重复投喂给 LLM，而是根据任务描述和索引找到本地冷存储的历史对话，
//     重新拼成一段指引性的，回喂给 LLM」
//
// 关键性质：
//   * **零 LLM 调用** —— 纯模板 + 关键词计数打分。它便宜到可以每轮跑，也不会引入新的失真。
//   * **有预算** —— 默认 ≤1200 字符，超了**显式告知截断**，不静默丢东西。
//   * **只给指针** —— 细节回到冷存储取，brief 本身不搬运原文。
//
// 只依赖 node 内置模块。

import { ENTRY_KINDS } from './journal.js';

export const DEFAULT_MAX_CHARS = 1200;
export const DEFAULT_LIMITS = { did: 3, pit: 2, open: 2 };

/** 关键词命中次数。没有关键词时全部为 0，排序退化为「越新越靠前」。 */
export function scoreEntry(entry, keywords) {
  if (!keywords || keywords.length === 0) return 0;
  const hay = String(entry.text).toLowerCase();
  let total = 0;
  for (const raw of keywords) {
    const k = String(raw).toLowerCase().trim();
    if (!k) continue;
    let idx = 0;
    while ((idx = hay.indexOf(k, idx)) !== -1) {
      total += 1;
      idx += k.length;
    }
  }
  return total;
}

/**
 * 按类型选条目：先按关键词打分，分数相同则新的优先；最后按 seq 升序还原时间顺序。
 * 返回 { did: [...], pit: [...], open: [...] }
 */
export function selectEntries(state, keywords = [], limits = DEFAULT_LIMITS) {
  const out = {};
  for (const kind of ENTRY_KINDS) {
    const scored = state.entries
      .filter((e) => e.kind === kind)
      .map((e) => ({ e, score: scoreEntry(e, keywords) }));
    scored.sort((a, b) => b.score - a.score || b.e.seq - a.e.seq);
    const n = limits[kind] ?? 2;
    out[kind] = scored.slice(0, n).map((x) => x.e).sort((a, b) => a.seq - b.seq);
  }
  return out;
}

const TRUNC_NOTE = '（已按预算截断，细节见上方指针）';

/**
 * 组装 brief。
 *
 * @param {object}  p
 * @param {object}  p.task      任务 doc（{id,title,status,progress,summary}）
 * @param {object}  p.state     journal state
 * @param {string[]} [p.keywords]
 * @param {number}  [p.maxChars]
 * @param {object}  [p.limits]
 * @param {string[]} [p.pointers] 指针段（默认指向任务文件与 journal）
 */
export function composeBrief({
  task,
  state,
  keywords = [],
  maxChars = DEFAULT_MAX_CHARS,
  limits = DEFAULT_LIMITS,
  pointers,
} = {}) {
  const t = task ?? { id: state?.taskId ?? '', title: '', status: '', progress: 0, summary: '' };
  const picked = selectEntries(state, keywords, limits);

  const pct = Math.round((t.progress ?? 0) * 100);
  const statusPart = t.status ? `  [${t.status} ${pct}%]` : '';
  // title 缺失或与 id 相同时不重复拼接 —— 免得渲染出「lonely · 」或「lonely · lonely」
  const titlePart = t.title && t.title !== t.id ? ` · ${t.title}` : '';
  const ptrList = pointers ?? [`MEMORY_${t.id}.md`, `JOURNAL_${t.id}.md`];

  // drop 越大越先被丢；pinned 永不被丢。
  const parts = [];
  parts.push({ drop: 5, text: `【任务】${t.id}${titlePart}${statusPart}` });
  if (t.summary) parts.push({ drop: 4, text: t.summary });

  const section = (label, arr, drop) => {
    for (let i = 0; i < arr.length; i++) {
      const e = arr[i];
      parts.push({
        drop: drop - i * 0.1, // 同一段里越靠前的越重要
        text: i === 0 ? `${label}\n- #${e.seq} ${e.text}` : `- #${e.seq} ${e.text}`,
      });
    }
  };
  section('【已定】', picked.did, 3);
  section('【坑】', picked.pit, 2);
  section('【未决】', picked.open, 1);
  if (state?.next) parts.push({ drop: 0, pinned: true, text: `【下一步】${state.next}` });
  parts.push({ drop: 0, pinned: true, text: `【指针】${ptrList.join(' / ')}（细节按需取，不要整份读回）` });

  const render = (alive) => alive.map((p) => p.text).join('\n');

  let alive = [...parts];
  let out = render(alive);
  if (out.length <= maxChars) return out;

  // 超预算了。先给「截断提示」留出位置，再决定能留多少 ——
  // 丢条目也算截断，必须说出来；静默丢东西是这套东西最不该犯的错。
  const note = '\n' + TRUNC_NOTE;
  const room = maxChars - note.length;
  if (room <= 20) {
    // 预算小到连提示都放不下：只能硬截断，此时不再加提示（加了反而更误导）
    return out.slice(0, Math.max(0, maxChars - 1)) + '…';
  }

  // 从 drop 最大的开始逐个丢弃，直到进预算
  for (const p of [...parts].sort((a, b) => b.drop - a.drop)) {
    if (out.length <= room) break;
    if (p.pinned) continue;
    alive = alive.filter((x) => x !== p);
    out = render(alive);
  }
  if (out.length > room) out = out.slice(0, room - 1) + '…';
  return out + note;
}
