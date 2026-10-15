// 最小任务文件读取器 —— 解析 lmmarr 的 MEMORY_<id>.md，供 brief 取「这个任务现在怎么样了」。
//
// 为什么不直接依赖 dsh-lmmarr：本 skill 必须自包含。
// 但它读的是**同一份文件、同一套 frontmatter**（格式契约见 references/journal-format.md），
// tests/taskdoc.test.ts 用 lmmarr 真实渲染出的样本钉住这个契约，防止两边漂移。
//
// 只依赖 node 内置模块。

import { existsSync, readFileSync } from 'node:fs';
import { assertTaskId } from './journal.js';

export const TASK_FILE_PREFIX = 'MEMORY_';
const STATUSES = ['todo', 'doing', 'blocked', 'done'];

export function taskPath(dir, taskId, prefix = TASK_FILE_PREFIX) {
  assertTaskId(taskId);
  const d = String(dir).replace(/[\\/]+$/, '');
  return `${d}/${prefix}${taskId}.md`;
}

/** 极简 frontmatter 解析：只认 `key: value` 单行，与 lmmarr store.ts 的 parseDoc 同规则。 */
export function parseTaskDoc(text, fallbackId = '') {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(String(text ?? ''));
  const fm = m ? m[1] : '';
  const body = m ? String(text).slice(m[0].length) : String(text ?? '');

  const kv = new Map();
  for (const line of fm.split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    kv.set(line.slice(0, i).trim(), line.slice(i + 1).trim());
  }

  const rawStatus = kv.get('status');
  const progress = Number(kv.get('progress') ?? '0');

  return {
    id: kv.get('id') ?? fallbackId,
    title: kv.get('title') ?? fallbackId,
    status: rawStatus !== undefined && STATUSES.includes(rawStatus) ? rawStatus : '',
    progress: Number.isFinite(progress) ? Math.min(1, Math.max(0, progress)) : 0,
    summary: kv.get('summary') ?? '',
    tags: parseInlineList(kv.get('tags') ?? ''),
    body,
  };
}

export function loadTaskDoc(dir, taskId, prefix = TASK_FILE_PREFIX) {
  const p = taskPath(dir, taskId, prefix);
  if (!existsSync(p)) return undefined;
  return parseTaskDoc(readFileSync(p, 'utf8'), taskId);
}

/** 解析 `[a, b]` 形式的内联数组（与 lmmarr 同规则） */
function parseInlineList(raw) {
  const m = /^\[(.*)\]$/.exec(String(raw).trim());
  const inner = m ? m[1] : String(raw);
  return inner
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}
