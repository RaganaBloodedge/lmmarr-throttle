// 能力门的契约测试 —— 两个分支的 MODE 映射、--require 的退出码、--json 可解析。
// 探测逻辑本身是只读且确定性的，所以可以真跑子进程断言，而不是打桩。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROBE = join(HERE, '..', 'skill', 'tools', 'agents-probe.mjs');

function run(args = [], env = {}) {
  try {
    const stdout = execFileSync(process.execPath, [PROBE, ...args], {
      encoding: 'utf8',
      env: { ...process.env, ...env },
    });
    return { code: 0, stdout };
  } catch (err) {
    return { code: err.status ?? -1, stdout: String(err.stdout ?? '') };
  }
}

test('强制 yes → MODE delegate', () => {
  const r = run([], { LMMARR_SUBAGENTS: 'yes' });
  assert.equal(r.code, 0);
  assert.equal(r.stdout.split('\n')[0], 'OK    agents=yes');
  assert.match(r.stdout, /MODE {2}delegate/);
});

test('强制 no → MODE self-compress', () => {
  const r = run([], { LMMARR_SUBAGENTS: 'no' });
  assert.equal(r.code, 0, '探测成功 ≠ 有子代理：恒为 0');
  assert.equal(r.stdout.split('\n')[0], 'OK    agents=no');
  assert.match(r.stdout, /MODE {2}self-compress/);
});

test('--require：不可用时退出码 3，可用时 0', () => {
  assert.equal(run(['--require'], { LMMARR_SUBAGENTS: 'no' }).code, 3);
  assert.equal(run(['--require'], { LMMARR_SUBAGENTS: 'yes' }).code, 0);
});

test('--json 输出可解析且含 mode', () => {
  const r = run(['--json'], { LMMARR_SUBAGENTS: 'yes' });
  const j = JSON.parse(r.stdout);
  assert.equal(j.ok, true);
  assert.equal(j.subagents, true);
  assert.equal(j.mode, 'delegate');
  assert.equal(j.harness, 'override');
});

test('环境变量以外的取值不当作覆盖（保守走真实探测）', () => {
  const r = run(['--json'], { LMMARR_SUBAGENTS: 'maybe' });
  const j = JSON.parse(r.stdout);
  assert.notEqual(j.harness, 'override');
});
