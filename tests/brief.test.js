// brief 的契约测试 —— 重点钉住「有预算、截断要显式、关键词能命中」。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { addEntry, emptyJournal, setNext } from '../skill/scripts/journal.js';
import { DEFAULT_MAX_CHARS, composeBrief, scoreEntry, selectEntries } from '../skill/scripts/brief.js';

function fixture() {
  const s = emptyJournal('api-retry');
  addEntry(s, 'did', '改用指数退避，基准 200ms');
  addEntry(s, 'did', '接入熔断器，阈值 50%');
  addEntry(s, 'pit', '熔断器默认半开窗口太短 → 误放流量；处理=调到 30s');
  addEntry(s, 'pit', '重试与幂等键冲突 → 服务端 409；处理=先建键再重试');
  addEntry(s, 'open', '并发压测下 P99 抖动未定位');
  setNext(s, '补熔断器单测');
  return s;
}

const task = {
  id: 'api-retry',
  title: '支付接口重试策略',
  status: 'doing',
  progress: 0.4,
  summary: '已定指数退避，待补熔断',
};

test('brief 含全部有内容的段，且给出指针', () => {
  const out = composeBrief({ task, state: fixture() });
  assert.match(out, /【任务】api-retry · 支付接口重试策略 {2}\[doing 40%\]/);
  assert.match(out, /已定指数退避，待补熔断/);
  assert.match(out, /【已定】/);
  assert.match(out, /【坑】/);
  assert.match(out, /【未决】/);
  assert.match(out, /【下一步】补熔断器单测/);
  assert.match(out, /【指针】.*JOURNAL_api-retry\.md/);
});

test('默认预算内，且永不超预算', () => {
  const out = composeBrief({ task, state: fixture() });
  assert.ok(out.length <= DEFAULT_MAX_CHARS, `实际 ${out.length}`);

  // 塞一堆内容，逼出截断
  const big = emptyJournal('big');
  for (let i = 0; i < 60; i++) addEntry(big, 'did', `第 ${i} 件做过的事，描述略长一些以便撑爆预算`);
  setNext(big, '继续');
  const t2 = { ...task, id: 'big', summary: 'x'.repeat(300) };
  const out2 = composeBrief({ task: t2, state: big, maxChars: 400 });
  assert.ok(out2.length <= 400, `实际 ${out2.length}`);
  assert.match(out2, /已按预算截断/);
  // 指针不能丢 —— 被牺牲的只能是中间明细
  assert.match(out2, /【指针】/);
});

test('关键词优先：命中多的条目被选中', () => {
  const s = fixture();
  const picked = selectEntries(s, ['熔断'], { did: 3, pit: 1, open: 2 });
  assert.equal(picked.pit.length, 1);
  assert.match(picked.pit[0].text, /熔断器/);

  const out = composeBrief({ task, state: s, keywords: ['熔断'] });
  assert.match(out, /熔断/);
});

test('无关键词时退化为「越新越靠前」，且仍按时间顺序呈现', () => {
  const s = emptyJournal('t');
  for (let i = 1; i <= 5; i++) addEntry(s, 'did', `第${i}件`);
  const picked = selectEntries(s, [], { did: 2, pit: 0, open: 0 });
  assert.deepEqual(
    picked.did.map((e) => e.seq),
    [4, 5],
  );
});

test('scoreEntry 计数命中次数', () => {
  assert.equal(scoreEntry({ text: '熔断 熔断 别的' }, ['熔断']), 2);
  assert.equal(scoreEntry({ text: 'abc ABC' }, ['abc']), 2, '大小写不敏感');
  assert.equal(scoreEntry({ text: 'abc' }, []), 0);
  assert.equal(scoreEntry({ text: 'abc' }, ['']), 0);
});

test('空 journal + 缺任务文件：brief 仍然可用（不抛异常）', () => {
  const out = composeBrief({ task: undefined, state: emptyJournal('lonely'), keywords: ['x'] });
  assert.match(out, /【任务】lonely(\s|$)/, '标题缺失时不拼出悬空的「·」');
  assert.match(out, /【指针】/);
  assert.doesNotMatch(out, /【未决】/, '空段不出现');
});

test('没有内容的段不出现', () => {
  const s = emptyJournal('t');
  addEntry(s, 'did', '只做过一件事');
  const out = composeBrief({ task, state: s });
  assert.match(out, /【已定】/);
  assert.doesNotMatch(out, /【坑】/);
  assert.doesNotMatch(out, /【未决】/);
  assert.doesNotMatch(out, /【下一步】/);
});
