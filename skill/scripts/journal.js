// 冷存储会话日志（journal）—— 会话内的「指令 + 结果」沉淀。
//
// 与 lmmarr 的分工（两套共用同一份冷存储，不抢目录）：
//   lmmarr 的 MEMORY_<id>.md   回答「这个任务现在怎么样了」 —— 可重写
//   本模块的 JOURNAL_<id>.md   回答「这个任务上发生过什么」 —— append-only
//
// 三条硬纪律由代码强制，不靠自觉 —— 因为「不记过程、不记原文」这件事，
// 一旦留给纪律，第一次赶时间就会破功：
//   1. 条目单行    —— 长串输出、代码块、diff 原文在结构上就写不进来；
//   2. 条目长度上限 —— 默认 400 字符，超了直接报错，逼你写成「指令 + 结果」；
//   3. 唯一允许的改写是 open -> pit（报错解决后降级），其余只能追加。
//
// 只依赖 node 内置模块。

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** 条目类型。next 不是条目而是单独一段（见 setNext），因为它表达「接下来做什么」，会被覆盖。 */
export const ENTRY_KINDS = ['did', 'pit', 'open'];

export const DEFAULT_MAX_ENTRY_CHARS = 400;
export const DEFAULT_JOURNAL_PREFIX = 'JOURNAL_';

/** 人读用的占位符（空条目 / 空 next）。解析时必须被忽略，不能回读成内容。 */
export const EMPTY_MARK = '_(未填)_';

/** 任务 id 白名单。与 lmmarr 的 store.ts 保持同一规则 —— journalPath 是唯一的路径拼装点，
 *  越界必须在这里挡住，否则 id 里带 `../` 就能写到记忆目录之外。 */
const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isTaskId(id) {
  return typeof id === 'string' && TASK_ID_RE.test(id) && !id.includes('..');
}

export function assertTaskId(id) {
  if (!isTaskId(id)) {
    throw new Error(
      `invalid task id: ${JSON.stringify(id)} —— 只允许字母数字开头、由 [A-Za-z0-9._-] 组成，且不得包含 ".."`,
    );
  }
  return id;
}

export function journalPath(dir, taskId, prefix = DEFAULT_JOURNAL_PREFIX) {
  assertTaskId(taskId);
  const d = String(dir).replace(/[\\/]+$/, '');
  return `${d}/${prefix}${taskId}.md`;
}

export function emptyJournal(taskId) {
  return { taskId, entries: [], next: '' };
}

// ---------- 纯函数：解析 / 渲染 / 变更 ----------

/** 解析 journal 文本。认不出的行一律忽略（标题、引用块、注释都安全）。 */
export function parseJournal(text, taskId) {
  const state = emptyJournal(taskId);
  let inNext = false;
  const nextBuf = [];
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const t = raw.trim();
    if (/^#{1,6}\s*next\s*$/i.test(t)) {
      inNext = true;
      continue;
    }
    if (inNext) {
      nextBuf.push(raw);
      continue;
    }
    const m = /^-\s*(did|pit|open)\s+#(\d+)\s+(.+)$/.exec(t);
    if (m) state.entries.push({ seq: Number(m[2]), kind: m[1], text: m[3].trim() });
  }
  state.next = nextBuf.join('\n').trim();
  // 占位符是人读用的，不能当成内容回读 —— 否则 brief 里会凭空多出「下一步」。
  // （这是被 CLI 端到端测试抓出来的：add 之后 brief 莫名多了一行。）
  if (state.next === EMPTY_MARK) state.next = '';
  state.entries.sort((a, b) => a.seq - b.seq);
  return state;
}

export function renderJournal(state) {
  const out = [
    `# 会话日志 · ${state.taskId}`,
    '',
    '> append-only。只记「指令 + 结果」；不记路径、不记过程、不记原文。',
    '> 唯一允许的改写：`open` 解决后降级为 `pit`（丢弃报错原文）。',
    '',
  ];
  if (state.entries.length === 0) {
    out.push('_(暂无条目)_');
  } else {
    for (const e of state.entries) out.push(`- ${e.kind}  #${e.seq}  ${e.text}`);
  }
  out.push('', '## next', '', state.next || EMPTY_MARK, '');
  return out.join('\n');
}

export function nextSeq(state) {
  return state.entries.reduce((m, e) => (e.seq > m ? e.seq : m), 0) + 1;
}

export function countByKind(state) {
  const out = { did: 0, pit: 0, open: 0 };
  for (const e of state.entries) if (out[e.kind] !== undefined) out[e.kind] += 1;
  return out;
}

function assertEntryText(text, maxChars) {
  const s = String(text ?? '').trim();
  if (!s) throw new Error('条目内容为空');
  if (/[\r\n]/.test(s)) {
    throw new Error('条目只能是单行 —— 长串输出、代码块、diff 原文一律不进 journal（留个指针就够）');
  }
  if (s.length > maxChars) {
    throw new Error(
      `条目 ${s.length} 字符，超过上限 ${maxChars}；只记「指令 + 结果」，过程与原文改留指针`,
    );
  }
  return s;
}

/** 追加一条条目，序号自动分配。 */
export function addEntry(state, kind, text, maxChars = DEFAULT_MAX_ENTRY_CHARS) {
  if (!ENTRY_KINDS.includes(kind)) {
    throw new Error(`未知条目类型: ${kind}（只允许 ${ENTRY_KINDS.join(' / ')}）`);
  }
  const entry = { seq: nextSeq(state), kind, text: assertEntryText(text, maxChars) };
  state.entries.push(entry);
  return entry;
}

/** 设置「下一步」。是覆盖语义，不是追加 —— next 只该有一条。 */
export function setNext(state, text, maxChars = DEFAULT_MAX_ENTRY_CHARS) {
  const s = String(text ?? '').trim();
  if (!s) {
    state.next = '';
    return state;
  }
  state.next = assertEntryText(s, maxChars);
  return state;
}

/**
 * open -> pit 降级：这是 journal 里**唯一允许的改写**。
 *
 * 语义要点：**报错原文被丢弃**，只保留调用方重写的「特征 + 处理法」。
 * 使用者必须显式提供 keep 文本，代码不给默认值 —— 强制把「总结」这一步做出来，
 * 否则就会退化成「把报错原文留着」。
 */
export function resolveEntry(state, seq, keepText, opts = {}) {
  const into = opts.into ?? 'pit';
  if (into !== 'pit' && into !== 'did') {
    throw new Error(`resolve 只能降级为 pit 或 did，收到 ${into}`);
  }
  const entry = state.entries.find((e) => e.seq === Number(seq));
  if (!entry) throw new Error(`没有 #${seq} 这条条目`);
  if (entry.kind !== 'open') throw new Error(`#${seq} 是 ${entry.kind}，只有 open 才能 resolve`);

  const maxChars = opts.maxChars ?? DEFAULT_MAX_ENTRY_CHARS;
  const keep = assertEntryText(keepText, maxChars);
  const dropped = entry.text;
  entry.kind = into;
  entry.text = keep;
  return { entry, dropped };
}

// ---------- IO 层 ----------

export function loadJournal(dir, taskId, prefix = DEFAULT_JOURNAL_PREFIX) {
  const p = journalPath(dir, taskId, prefix);
  if (!existsSync(p)) return emptyJournal(taskId);
  return parseJournal(readFileSync(p, 'utf8'), taskId);
}

export function saveJournal(dir, state, prefix = DEFAULT_JOURNAL_PREFIX) {
  const p = journalPath(dir, state.taskId, prefix);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, renderJournal(state), 'utf8');
  return p;
}

/** 目录下所有 JOURNAL_<id>.md 的 id（不排序、去重由调用方决定） */
export function listJournalIds(dir, prefix = DEFAULT_JOURNAL_PREFIX) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith('.md')) continue;
    const id = name.slice(prefix.length, -3);
    if (isTaskId(id)) out.push(id);
  }
  return out.sort();
}
