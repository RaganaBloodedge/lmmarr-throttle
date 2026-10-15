// journal 内核的契约测试 —— 重点钉住三条「由代码强制」的纪律。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  addEntry,
  assertTaskId,
  countByKind,
  emptyJournal,
  isTaskId,
  journalPath,
  listJournalIds,
  loadJournal,
  parseJournal,
  renderJournal,
  resolveEntry,
  saveJournal,
  setNext,
} from '../skill/scripts/journal.js';

test('addEntry 自动分配递增序号', () => {
  const s = emptyJournal('t');
  assert.equal(addEntry(s, 'did', 'A').seq, 1);
  assert.equal(addEntry(s, 'pit', 'B').seq, 2);
  assert.equal(addEntry(s, 'open', 'C').seq, 3);
  assert.deepEqual(countByKind(s), { did: 1, pit: 1, open: 1 });
});

test('纪律一：条目必须单行 —— 长串输出在结构上就写不进来', () => {
  const s = emptyJournal('t');
  assert.throws(() => addEntry(s, 'did', '第一行\n第二行'), /只能是单行/);
  assert.throws(() => addEntry(s, 'did', 'a\r\nb'), /只能是单行/);
  assert.equal(s.entries.length, 0, '被拒后不应留下半条');
});

test('纪律二：条目长度上限 —— 逼你写成「指令 + 结果」', () => {
  const s = emptyJournal('t');
  assert.throws(() => addEntry(s, 'did', 'x'.repeat(401)), /超过上限 400/);
  // 上限可放宽（调用方显式选择）
  assert.equal(addEntry(s, 'did', 'x'.repeat(401), 500).seq, 1);
});

test('未知类型被拒绝', () => {
  const s = emptyJournal('t');
  assert.throws(() => addEntry(s, 'todo', 'x'), /未知条目类型/);
});

test('纪律三：open -> pit 降级会丢弃报错原文，且只有 open 能降级', () => {
  const s = emptyJournal('t');
  addEntry(s, 'did', '先做了别的');
  const err = addEntry(s, 'open', 'Traceback: File "a.py" line 12 一大段报错原文');

  const r = resolveEntry(s, err.seq, '特征=单字碎片；处理=放弃不重试');
  assert.equal(r.dropped, 'Traceback: File "a.py" line 12 一大段报错原文', '原报错应当被返回以便调用方知情');
  assert.equal(r.entry.kind, 'pit');
  assert.equal(r.entry.text, '特征=单字碎片；处理=放弃不重试');
  assert.equal(s.entries.find((e) => e.seq === err.seq).text.includes('Traceback'), false);

  assert.throws(() => resolveEntry(s, 1, 'x'), /只有 open 才能 resolve/);
  assert.throws(() => resolveEntry(s, 99, 'x'), /没有 #99/);
});

test('resolve 不给 keep 文本就报错（强制把「总结」这一步做出来）', () => {
  const s = emptyJournal('t');
  const e = addEntry(s, 'open', '报错');
  assert.throws(() => resolveEntry(s, e.seq, '   '), /条目内容为空/);
});

test('setNext 是覆盖语义，不是追加', () => {
  const s = emptyJournal('t');
  setNext(s, '第一步');
  setNext(s, '第二步');
  assert.equal(s.next, '第二步');
  setNext(s, '');
  assert.equal(s.next, '');
});

test('parse/render 往返一致（含 next 段）', () => {
  const s = emptyJournal('api-retry');
  addEntry(s, 'did', '改 main.py 加重复惩罚 → 5 条断言通过');
  addEntry(s, 'pit', '中文 PDF 文本层按列倒序 → 提取失败；处理=放弃');
  addEntry(s, 'open', 'smoke_test 第 3 例 flaky');
  setNext(s, '补第 4 例');

  const text = renderJournal(s);
  const back = parseJournal(text, 'api-retry');
  assert.deepEqual(back.entries, s.entries);
  assert.equal(back.next, '补第 4 例');
  assert.equal(renderJournal(back), text, '渲染应当是确定性的');
});

test('parse 容忍未知行与空文件', () => {
  assert.deepEqual(parseJournal('', 't').entries, []);
  const s = parseJournal('# 标题\n\n> 引用\n\n- did  #1  一条\n\n随便一行\n', 't');
  assert.equal(s.entries.length, 1);
  assert.equal(s.entries[0].seq, 1);
});

test('空占位符不能被回读成内容（否则 brief 会凭空多出「下一步」）', () => {
  const s = emptyJournal('t');
  const back = parseJournal(renderJournal(s), 't');
  assert.equal(back.next, '', '未填的 next 回读后必须仍是空');
  assert.deepEqual(back.entries, []);
});

test('task id 白名单挡住路径穿越', () => {
  assert.equal(isTaskId('api-retry'), true);
  assert.equal(isTaskId('a.b_c-1'), true);
  assert.equal(isTaskId('../evil'), false);
  assert.equal(isTaskId('a/../b'), false);
  assert.equal(isTaskId('.hidden'), false);
  assert.equal(isTaskId(''), false);
  assert.throws(() => journalPath('/mem', '../evil'), /invalid task id/);
  assert.throws(() => assertTaskId('a/b'), /invalid task id/);
});

test('IO：落盘 / 读回 / 目录列举', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lmt-journal-'));
  const s = emptyJournal('alpha');
  addEntry(s, 'did', '一件做过的事');
  const p = saveJournal(dir, s);
  assert.equal(existsSync(p), true);
  assert.match(readFileSync(p, 'utf8'), /- did {2}#1 {2}一件做过的事/);

  const back = loadJournal(dir, 'alpha');
  assert.equal(back.entries.length, 1);

  // 目录不存在时读回空 journal，而不是抛异常
  assert.deepEqual(loadJournal(join(dir, 'nope'), 'alpha').entries, []);

  writeFileSync(join(dir, 'JOURNAL_beta.md'), renderJournal(emptyJournal('beta')), 'utf8');
  writeFileSync(join(dir, 'JOURNAL_..evil.md'), 'x', 'utf8'); // 名字里含 ".." 的非法 id
  writeFileSync(join(dir, 'JOURNAL_.hidden.md'), 'x', 'utf8'); // 以 "." 开头，不合法
  assert.deepEqual(listJournalIds(dir), ['alpha', 'beta'], '非法 id 文件名应被忽略而不是让整条链炸掉');
});
