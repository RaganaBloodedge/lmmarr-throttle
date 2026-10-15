#!/usr/bin/env node
// install-skill —— 把 skill/ 装（或核对）到宿主的 skill 目录。
//
// 为什么是这个形态：本仓**零构建** —— skill/ 里的 JS 就是源码，也是产物。
// 所以「安装」这一步没有编译，只有复制与核对，从根上不存在「源码与产物不一致」。
//
// 用法：
//   node dev/install-skill.mjs                      # 装到 ~/.workbuddy/skills/lmmarr-throttle
//   node dev/install-skill.mjs --dest <目录>        # 装到指定目录
//   node dev/install-skill.mjs --check              # 只核对，不写入（有差异退出 1）
//   node dev/install-skill.mjs --check --dest <目录>

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'skill');
const DEFAULT_NAME = 'lmmarr-throttle';

const argv = process.argv.slice(2);
const check = argv.includes('--check');
const destFlag = argv.indexOf('--dest');
const DEST =
  destFlag >= 0 && argv[destFlag + 1]
    ? argv[destFlag + 1]
    : process.env.LMMARR_SKILL_DEST ?? join(homedir(), '.workbuddy', 'skills', DEFAULT_NAME);

/** 递归列出目录下所有文件的相对路径（排序） */
function walk(dir, base = dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, name.name);
    if (name.isDirectory()) out.push(...walk(p, base));
    else if (name.isFile()) out.push(relative(base, p).split('\\').join('/'));
  }
  return out.sort();
}

function compare(src, dest) {
  const a = walk(src);
  const b = walk(dest);
  const diffs = [];
  for (const f of a) {
    if (!b.includes(f)) diffs.push(`缺失  ${f}`);
    else if (!readFileSync(join(src, f)).equals(readFileSync(join(dest, f)))) diffs.push(`不同  ${f}`);
  }
  for (const f of b) if (!a.includes(f)) diffs.push(`多余  ${f}`);
  return { files: a, diffs };
}

// ---------- --check ----------

if (check) {
  if (!existsSync(DEST)) {
    console.log(`FAIL  目标目录不存在: ${DEST}`);
    console.log('FIX   先跑 `node dev/install-skill.mjs` 装一次');
    process.exit(1);
  }
  const { files, diffs } = compare(SRC, DEST);
  if (diffs.length) {
    console.log(`FAIL  与仓内 skill/ 有 ${diffs.length} 处差异（共 ${files.length} 个文件）`);
    for (const d of diffs) console.log(`KEY   ${d}`);
    console.log('FIX   跑 `node dev/install-skill.mjs` 重新同步');
    process.exit(1);
  }
  console.log(`OK    已同步 · ${files.length} 个文件 · ${DEST}`);
  process.exit(0);
}

// ---------- 安装 ----------

if (!existsSync(SRC)) {
  console.log(`FAIL  找不到源目录: ${SRC}`);
  process.exit(1);
}
mkdirSync(DEST, { recursive: true });
// 先同步、后删多余 —— 顺序反了会出现「删完还没拷」的空窗
const staging = mkdtempSync(join(tmpdir(), 'lmt-install-'));
cpSync(SRC, staging, { recursive: true });
for (const f of walk(DEST)) rmSync(join(DEST, f), { force: true });
cpSync(staging, DEST, { recursive: true });
rmSync(staging, { recursive: true, force: true });

const { files } = compare(SRC, DEST);

// 安装后自检：两条「坏掉的 skill 比没有更糟」的路径各跑一次
function smoke(args, expectCode) {
  try {
    execFileSync(process.execPath, args, { stdio: 'pipe' });
    return 0 === expectCode;
  } catch (err) {
    return (err.status ?? -1) === expectCode;
  }
}
const cliOk = smoke([join(DEST, 'scripts', 'cli.js')], 2); // 无参数 → 用法 + 退出码 2
const gateOk = smoke([join(DEST, 'tools', 'agents-probe.mjs')], 0);

console.log(`OK    skill 已安装 · ${files.length} 个文件`);
console.log(`KEY   dest=${DEST}`);
console.log(`KEY   scripts=${walk(join(DEST, 'scripts')).join(',')}`);
console.log(`KEY   tools=${walk(join(DEST, 'tools')).join(',')}`);
console.log(`KEY   references=${walk(join(DEST, 'references')).join(',')}`);
console.log(`KEY   smoke=cli:${cliOk ? 'ok' : 'FAIL'},gate:${gateOk ? 'ok' : 'FAIL'} · ${statSync(join(DEST, 'SKILL.md')).size}B`);
if (!cliOk || !gateOk) process.exit(1);
