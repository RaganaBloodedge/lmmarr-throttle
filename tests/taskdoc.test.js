// taskdoc 的格式契约测试。
//
// 关键点：这段样本是 **lmmarr 的 store.ts renderDoc() 真实渲染出来的形状**
// （frontmatter 顺序、tags 写成 `[a, b]`、updated 是 ISO 串）。
// 两个项目共用同一份冷存储，所以这个解析器必须一直吃得下它 —— 一旦 lmmarr 改了渲染，
// 这条测试会红，提醒我们两边对齐，而不是安静地读出空任务名。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadTaskDoc, parseTaskDoc, taskPath } from '../skill/scripts/taskdoc.js';

const LMMARR_SAMPLE = `---
id: api-retry
title: 支付接口重试策略
status: doing
progress: 0.4
updated: 2026-10-15T09:35:36.605Z
tags: [backend, reliability]
summary: 已定指数退避，待补熔断
---

正文若干，brief 不需要。

- 列表项
`;

test('能吃下 lmmarr 渲染出的任务文件', () => {
  const d = parseTaskDoc(LMMARR_SAMPLE, 'fallback');
  assert.equal(d.id, 'api-retry');
  assert.equal(d.title, '支付接口重试策略');
  assert.equal(d.status, 'doing');
  assert.equal(d.progress, 0.4);
  assert.deepEqual(d.tags, ['backend', 'reliability']);
  assert.equal(d.summary, '已定指数退避，待补熔断');
  assert.match(d.body, /正文若干/);
});

test('缺字段 / 空文件时给安全默认值，不抛异常', () => {
  const d = parseTaskDoc('', 'fb');
  assert.equal(d.id, 'fb');
  assert.equal(d.title, 'fb');
  assert.equal(d.status, '');
  assert.equal(d.progress, 0);
  assert.deepEqual(d.tags, []);
});

test('progress 越界被夹到 [0,1]，状态词表外的值不认', () => {
  const d = parseTaskDoc('---\nprogress: 3\nstatus: weird\n---\n', 'x');
  assert.equal(d.progress, 1);
  assert.equal(d.status, '');
});

test('loadTaskDoc：文件不存在返回 undefined', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lmt-taskdoc-'));
  assert.equal(loadTaskDoc(dir, 'nope'), undefined);
  writeFileSync(taskPath(dir, 'here'), LMMARR_SAMPLE, 'utf8');
  assert.equal(loadTaskDoc(dir, 'here').title, '支付接口重试策略');
});
