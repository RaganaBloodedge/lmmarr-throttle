// session-stats 执行器的契约测试 —— 用合成会话喂它，钉住口径与失败语义。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXEC = join(HERE, '..', 'skill', 'tools', 'exec', 'session-stats.mjs');

function run(args) {
  try {
    return { code: 0, stdout: execFileSync(process.execPath, [EXEC, ...args], { encoding: 'utf8' }) };
  } catch (err) {
    return { code: err.status ?? -1, stdout: String(err.stdout ?? '') };
  }
}

/** 造一个最小但形状正确的会话：1 轮、2 次模型调用、2 个工具。 */
function makeSession() {
  const dir = mkdtempSync(join(tmpdir(), 'lmt-stats-'));
  const p = join(dir, 'session.jsonl');
  const lines = [
    { type: 'session-meta', id: 'x' },
    {
      type: 'message',
      role: 'user',
      content: '<system-reminder>注入的一部分</system-reminder>\n<user_query>看看这个</user_query>',
    },
    {
      type: 'function_call',
      name: 'Bash',
      arguments: 'ls',
      callId: 'c1',
      providerData: { messageId: 'm1', requestModelName: 'model-a' },
      message: { usage: { input_tokens: 1000, output_tokens: 50, total_tokens: 1050, cache_read_input_tokens: 900 } },
    },
    { type: 'function_call_result', name: 'Bash', output: 'x'.repeat(300) },
    { type: 'reasoning', content: '想一下' },
    {
      type: 'function_call',
      name: 'Read',
      arguments: 'file',
      callId: 'c2',
      providerData: { messageId: 'm2', requestModelName: 'model-a' },
      message: { usage: { input_tokens: 3000, output_tokens: 80, total_tokens: 3080, cache_read_input_tokens: 2900 } },
    },
    { type: 'function_call_result', name: 'Read', output: 'y'.repeat(12000) },
    // 同一 messageId 的第二条（真实格式会这样重复），不应被重复计数
    {
      type: 'function_call',
      name: 'Read',
      arguments: 'file',
      callId: 'c2b',
      providerData: { messageId: 'm2', requestModelName: 'model-a' },
      message: { usage: { input_tokens: 3000, output_tokens: 80, total_tokens: 3080, cache_read_input_tokens: 2900 } },
    },
  ];
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n') + '\n这行不是 JSON\n', 'utf8');
  return p;
}

test('正常会话：OK/KEY/DETAIL 齐全，usage 按 messageId 去重', () => {
  const p = makeSession();
  const r = run([p, '--detail', join(dirname(p), 'detail.json')]);
  assert.equal(r.code, 0);
  const lines = r.stdout.split('\n').filter(Boolean);
  assert.match(lines[0], /^OK {4}1 轮 · 2 次模型调用/);
  assert.ok(lines.length <= 10, '成功回执压在 10 行内');
  assert.ok(lines.some((l) => /^KEY {3}input=4,000$/.test(l)), '4000 = 1000 + 3000（重复的 m2 只算一次）');
  assert.ok(lines.some((l) => /^KEY {3}cache-read=95\.0%$/.test(l)), '3800 / 4000');
  assert.ok(lines.some((l) => /^DETAIL /.test(l)));
  assert.ok(existsSync(join(dirname(p), 'detail.json')));
});

test('解析失败的行被跳过，不影响统计', () => {
  const p = makeSession();
  const r = run([p, '--json']);
  const j = JSON.parse(r.stdout);
  assert.equal(j.detail.badLines, 1);
  assert.equal(j.detail.lines, 9);
});

test('工具分布与最大返回被算出来', () => {
  const p = makeSession();
  const r = run([p, '--json']);
  const j = JSON.parse(r.stdout);
  assert.equal(j.detail.tools.Bash.calls, 1);
  assert.equal(j.detail.tools.Read.maxResult, 12000);
  assert.equal(j.detail.topResults[0].name, 'Read');
  assert.equal(j.detail.chars.reasoning, 3);
});

test('文件不存在 → FAIL + 退出 1', () => {
  const r = run([join(tmpdir(), 'definitely-not-here-12345.jsonl')]);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /^FAIL {2}会话文件不存在/);
  assert.match(r.stdout, /^FIX/m);
});

test('没有 usage 的会话 → FAIL 而不是打印 0', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lmt-stats-'));
  const p = join(dir, 'empty.jsonl');
  writeFileSync(p, '{"type":"message","role":"user","content":"hi"}\n', 'utf8');
  const r = run([p]);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /没读到任何带 usage 的模型调用/);
});

test('缺参数 → 用法错误退出 2 并给出用法', () => {
  const r = run([]);
  assert.equal(r.code, 2);
  assert.match(r.stdout, /^FIX/m);
});
