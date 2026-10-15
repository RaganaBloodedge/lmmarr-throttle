// 执行器输出协议的契约测试：
//   成功态必须是「结构强制地短」，失败态必须「一点都不丢」。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MAX_OK_LINES, failLines, okLines } from '../skill/scripts/protocol.js';

test('成功回执：结论在最前，指针在最后', () => {
  const lines = okLines('3 轮 · 12 次调用', { a: 1, b: 2 }, '/tmp/x.json');
  assert.equal(lines[0], 'OK    3 轮 · 12 次调用');
  assert.equal(lines.at(-1), 'DETAIL /tmp/x.json');
  assert.ok(lines.some((l) => l === 'KEY   a=1'));
});

test('成功回执恒定压在 10 行内，被牺牲的只能是中间 KEY', () => {
  const keys = {};
  for (let i = 0; i < 40; i++) keys[`k${i}`] = i;
  const lines = okLines('多字段', keys, '/tmp/detail.json');
  assert.equal(lines.length, MAX_OK_LINES);
  assert.equal(lines[0], 'OK    多字段');
  assert.equal(lines.at(-1), 'DETAIL /tmp/detail.json', '指针永远不能丢');
});

test('空 / undefined 的 KEY 被跳过', () => {
  const lines = okLines('x', { a: 1, b: undefined, c: null, d: '' });
  assert.deepEqual(
    lines.filter((l) => l.startsWith('KEY')),
    ['KEY   a=1'],
  );
});

test('失败回执：原因 + 修法 + 全量原文（不截断）', () => {
  const raw = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n');
  const lines = failLines('执行失败: ENOENT', '检查路径', raw);
  assert.equal(lines[0], 'FAIL  执行失败: ENOENT');
  assert.equal(lines[1], 'FIX   检查路径');
  assert.equal(lines.length, 5, '结构与行数无关，原文是单独一段');
  assert.equal(lines.at(-1).split('\n').length, 200, '原始输出必须整段保留');
  assert.match(lines.join('\n'), /line 199/);
});

test('失败回执在没有原文时不加空段', () => {
  assert.deepEqual(failLines('boom', undefined, ''), ['FAIL  boom']);
  assert.deepEqual(failLines('boom'), ['FAIL  boom']);
});
