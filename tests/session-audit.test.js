// session-audit 执行器的契约测试。
// 除常规形状外，专门钉两件在真实数据里踩过的事：
//   ① usage 不一定挂在同一 messageId 的首个 function_call 事件上（实测 728 个事件里 194 个不带）；
//      若按「首个事件」取，会把整次调用漏掉（曾因此把 76M 量成 60M）。
//   ② 「可省上界」的三项份额必须与手算一致 —— 它是拿来跟改动前后对比的，口径不能漂。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXEC = join(HERE, '..', 'skill', 'tools', 'exec', 'session-audit.mjs');

function run(args) {
  try {
    return { code: 0, stdout: execFileSync(process.execPath, [EXEC, ...args], { encoding: 'utf8' }) };
  } catch (err) {
    return { code: err.status ?? -1, stdout: String(err.stdout ?? '') };
  }
}

const fc = (name, args, callId, mid, inTok, cache, withUsage = true) => ({
  type: 'function_call',
  name,
  arguments: args,
  callId,
  providerData: { messageId: mid },
  ...(withUsage ? { message: { usage: { input_tokens: inTok, output_tokens: 10, cache_read_input_tokens: cache } } } : {}),
});
const res = (name, n, callId) => ({ type: 'function_call_result', name, callId, output: 'x'.repeat(n) });

/**
 * 5 次调用，权重手算：
 *   m1 Bash(多行) 3000 字符  k=0 W=4  → 执行器项 (3000-600)*4 = 9600
 *   m2 Read a.ts 20000 字符  k=1 W=3  → 大读截断 (20000-8000)*3 = 36000
 *   m3 Read a.ts  9000 字符  k=2 W=2  → 重复读 9000*2 = 18000 ＋ 截断 (9000-8000)*2 = 2000
 *   m4 Read b.ts  1000 字符  k=3 W=1
 *   m5 Bash 单行   100 字符  k=4 W=0
 *   totalW = 91000 ；输入合计 15000
 */
function makeSession() {
  const dir = mkdtempSync(join(tmpdir(), 'lmt-audit-'));
  const p = join(dir, 'session.jsonl');
  const lines = [
    { type: 'session-meta', id: 'x' },
    { type: 'message', role: 'user', content: '<user_query>看看这个</user_query>' },
    fc('Bash', JSON.stringify({ command: 'echo a\necho b' }), 'c1', 'm1', 1000, 900),
    res('Bash', 3000, 'c1'),
    fc('Read', JSON.stringify({ file_path: 'a.ts', limit: 100 }), 'c2', 'm2', 2000, 1900),
    res('Read', 20000, 'c2'),
    // 坑①：同 messageId 的首个事件不带 usage，真正的 usage 在第二条上
    fc('Read', JSON.stringify({ file_path: 'a.ts', limit: 100 }), 'c3', 'm3', 0, 0, false),
    fc('Read', JSON.stringify({ file_path: 'a.ts', limit: 100 }), 'c3b', 'm3', 3000, 2900),
    res('Read', 9000, 'c3b'),
    fc('Read', JSON.stringify({ file_path: 'b.ts' }), 'c4', 'm4', 4000, 3900),
    res('Read', 1000, 'c4'),
    fc('Bash', JSON.stringify({ command: 'ls' }), 'c5', 'm5', 5000, 4900),
    res('Bash', 100, 'c5'),
  ];
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
  return p;
}

test('正常会话：OK/KEY/DETAIL，且 usage 按「首个带 usage 的事件」计', () => {
  const p = makeSession();
  const r = run([p, '--detail', join(dirname(p), 'd.json')]);
  assert.equal(r.code, 0);
  const lines = r.stdout.split('\n').filter(Boolean);
  assert.match(lines[0], /^OK {4}1 轮 · 5 次调用/);
  assert.ok(lines.length <= 10, '成功回执压在 10 行内');
  assert.ok(lines.some((l) => /^DETAIL /.test(l)));
  assert.ok(existsSync(join(dirname(p), 'd.json')));
});

test('usage 在第二个事件上也不能漏（曾经把 76M 量成 60M）', () => {
  const p = makeSession();
  const j = JSON.parse(run([p, '--json']).stdout);
  assert.equal(j.detail.modelCalls, 5);
  assert.equal(j.detail.tokens.input, 15000, '1000+2000+3000+4000+5000 —— m3 的 usage 挂在第二个事件上');
  assert.equal(j.detail.functionCallsWithoutUsage, 1);
});

test('三项份额与手算一致', () => {
  const p = makeSession();
  const a = JSON.parse(run([p, '--json']).stdout).detail.addressable;
  assert.equal(a.duplicateReadsPct, 19.8, '18000 / 91000');
  assert.equal(a.oversizedReadsPct, 41.8, '(36000 + 2000) / 91000');
  assert.equal(a.inlineScriptsPct, 10.5, '9600 / 91000');
  assert.equal(a.upperBoundPct, 72.1, '三项之和（上界口径）');
});

test('Read 纪律与重复读被点名', () => {
  const p = makeSession();
  const d = JSON.parse(run([p, '--json']).stdout).detail;
  assert.equal(d.reads.total, 3);
  assert.equal(d.reads.withLimit, 2);
  assert.deepEqual(d.duplicateReads.paths, [{ path: 'a.ts', n: 2 }]);
  assert.equal(d.byTool.Read.maxChars, 20000);
});

test('--read-cap 可调，且调大后截断份额下降', () => {
  const p = makeSession();
  const big = JSON.parse(run([p, '--json', '--read-cap', '50000']).stdout).detail.addressable;
  assert.equal(big.oversizedReadsPct, 0);
});

test('文件不存在 → FAIL + 退出 1', () => {
  const r = run([join(tmpdir(), 'definitely-not-here-audit.jsonl')]);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /^FAIL {2}会话文件不存在/);
  assert.match(r.stdout, /^FIX/m);
});

test('没有 usage 的会话 → FAIL 而不是打印 0', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lmt-audit-'));
  const p = join(dir, 'empty.jsonl');
  writeFileSync(p, '{"type":"message","role":"user","content":"hi"}\n', 'utf8');
  const r = run([p]);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /没读到任何带 usage 的模型调用/);
});

test('缺参数 → 用法错误退出 2', () => {
  const r = run([]);
  assert.equal(r.code, 2);
  assert.match(r.stdout, /^FIX/m);
});
