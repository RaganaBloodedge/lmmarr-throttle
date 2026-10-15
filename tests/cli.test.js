// CLI 端到端契约测试。
//
// 教训（来自上一个项目）：**断言退出码时绝不接管道** —— `cmd | head` 拿到的 $? 是 head 的。
// 这里用 execFileSync 直接取真实退出码与 stdout，不经 shell。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'skill', 'scripts', 'cli.js');

function run(args) {
  try {
    return { code: 0, stdout: execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8' }) };
  } catch (err) {
    return { code: err.status ?? -1, stdout: String(err.stdout ?? '') };
  }
}

function newDir() {
  const d = mkdtempSync(join(tmpdir(), 'lmt-cli-'));
  writeFileSync(
    join(d, 'MEMORY_api-retry.md'),
    '---\nid: api-retry\ntitle: 支付接口重试策略\nstatus: doing\nprogress: 0.4\ntags: [backend]\nsummary: 已定指数退避\n---\n',
    'utf8',
  );
  return d;
}

test('无参数 → 打印用法并退出 2（不是一次成功调用）', () => {
  const r = run([]);
  assert.equal(r.code, 2);
  assert.match(r.stdout, /lmmarr-throttle/);
});

test('help → 退出 0', () => {
  assert.equal(run(['help']).code, 0);
});

test('未知命令 → 退出 2', () => {
  assert.equal(run(['nope']).code, 2);
});

test('add：写盘 + 协议回执', () => {
  const dir = newDir();
  const r = run(['journal', dir, 'api-retry', 'add', 'did', '改某处并跑通 5 条断言']);
  assert.equal(r.code, 0);
  assert.match(r.stdout.split('\n')[0], /^OK {4}journal 追加 #1 did$/);
  assert.ok(r.stdout.split('\n').length <= 10, '成功回执必须压在 10 行内');
  assert.match(readFileSync(join(dir, 'JOURNAL_api-retry.md'), 'utf8'), /- did {2}#1 {2}改某处并跑通 5 条断言/);
});

test('add：超长条目 → 退出 2 且不落盘（不留下半条）', () => {
  const dir = newDir();
  const r = run(['journal', dir, 'api-retry', 'add', 'did', 'x'.repeat(500)]);
  assert.equal(r.code, 2);
  assert.match(r.stdout, /^FAIL/);
  assert.match(r.stdout, /FIX/, '失败必须给出修法');
  assert.equal(existsSync(join(dir, 'JOURNAL_api-retry.md')), false);
});

test('add：非法任务 id → 退出 2 且目录里什么都不该多出来', () => {
  const dir = newDir();
  const before = readdirSync(dir).sort();
  const r = run(['journal', dir, '../evil', 'add', 'did', 'x']);
  assert.equal(r.code, 2);
  assert.match(r.stdout, /invalid task id/);
  assert.deepEqual(readdirSync(dir).sort(), before, '越界写必须被挡住');
});

test('resolve：缺 --keep → 退出 2（强制把总结做出来）', () => {
  const dir = newDir();
  run(['journal', dir, 'api-retry', 'add', 'open', '某个报错']);
  const r = run(['journal', dir, 'api-retry', 'resolve', '1']);
  assert.equal(r.code, 2);
  assert.match(r.stdout, /必须给 --keep/);
});

test('resolve：成功后原报错从文件里消失', () => {
  const dir = newDir();
  run(['journal', dir, 'api-retry', 'add', 'open', 'Traceback 一大段原始报错']);
  const r = run(['journal', dir, 'api-retry', 'resolve', '1', '--keep', '特征=偶发超时；处理=加长超时到 30s']);
  assert.equal(r.code, 0);
  const text = readFileSync(join(dir, 'JOURNAL_api-retry.md'), 'utf8');
  assert.doesNotMatch(text, /Traceback/);
  assert.match(text, /- pit {2}#1 {2}特征=偶发超时/);
});

test('next：覆盖语义', () => {
  const dir = newDir();
  run(['journal', dir, 'api-retry', 'next', '第一步']);
  run(['journal', dir, 'api-retry', 'next', '第二步']);
  assert.match(readFileSync(join(dir, 'JOURNAL_api-retry.md'), 'utf8'), /## next\n\n第二步/);
});

test('brief：出内容、在预算内、默认给到任务信息', () => {
  const dir = newDir();
  run(['journal', dir, 'api-retry', 'add', 'did', '接入熔断器']);
  const r = run(['brief', dir, 'api-retry']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /【任务】api-retry · 支付接口重试策略/);
  assert.ok(r.stdout.length <= 1200);
});

test('brief：--max 生效，且截断被显式告知', () => {
  const dir = newDir();
  for (let i = 0; i < 30; i++) run(['journal', dir, 'api-retry', 'add', 'did', `第 ${i} 件做过的事，稍长一点`]);
  const r = run(['brief', dir, 'api-retry', '--max', '150']);
  assert.equal(r.code, 0);
  assert.ok(r.stdout.length <= 150, `实际 ${r.stdout.length}`);
  assert.match(r.stdout, /已按预算截断/);
  assert.match(r.stdout, /【指针】/, '指针不能被牺牲');
});

test('brief：任务文件不存在也照样能出 brief', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lmt-cli-'));
  run(['journal', dir, 'ghost', 'add', 'did', '只留了 journal']);
  const r = run(['brief', dir, 'ghost']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /【任务】ghost/);
  assert.match(r.stdout, /只留了 journal/);
});

test('--json 输出可解析', () => {
  const dir = newDir();
  run(['journal', dir, 'api-retry', 'add', 'pit', '一个坑']);
  const r = run(['brief', dir, 'api-retry', '--json']);
  const j = JSON.parse(r.stdout);
  assert.equal(j.ok, true);
  assert.equal(j.taskId, 'api-retry');
  assert.ok(j.chars <= j.maxChars);
});
