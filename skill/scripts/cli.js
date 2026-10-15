#!/usr/bin/env node
// lmmarr-throttle CLI —— journal（写侧）与 brief（读侧）两个命令族。
//
// 设计约定（很重要）：
//   * **写命令走执行器协议**（OK / KEY / DETAIL），输出恒定压在 10 行内；
//   * **读命令直接出内容**（brief 文本、journal 正文）—— 它们的产品就是那段文本。
//
// 用法：
//   node cli.js journal <dir> <taskId> add <did|pit|open> <文本...> [--max-entry 400] [--json]
//   node cli.js journal <dir> <taskId> resolve <序号> --keep <总结文本> [--into pit] [--json]
//   node cli.js journal <dir> <taskId> next <文本...> [--json]
//   node cli.js journal <dir> <taskId> show [--json]
//   node cli.js brief   <dir> <taskId> [关键词...] [--max 1200] [--json]
//
// 退出码：0 成功 / 1 执行失败（IO）/ 2 用法或校验错误

import {
  addEntry,
  assertTaskId,
  countByKind,
  journalPath,
  loadJournal,
  renderJournal,
  resolveEntry,
  saveJournal,
  setNext,
} from './journal.js';
import { loadTaskDoc, taskPath } from './taskdoc.js';
import { DEFAULT_MAX_CHARS, composeBrief } from './brief.js';
import { fail, failUsage, ok } from './protocol.js';

const USAGE = `lmmarr-throttle —— 会话内上下文节流

  journal <dir> <taskId> add <did|pit|open> <文本...>   追加一条「指令 + 结果」
  journal <dir> <taskId> resolve <序号> --keep <文本>   报错已解决：open 降级为 pit，丢弃原报错
  journal <dir> <taskId> next <文本...>                 设置「下一步」（覆盖）
  journal <dir> <taskId> show                            打印该任务的 journal 正文
  brief   <dir> <taskId> [关键词...]                     从冷存储重拼一段指引（零 LLM 调用）

  通用选项： --json        输出 JSON
            --max-entry N  单条条目字符上限（默认 400）
            brief 专属： --max N    brief 字符预算（默认 ${DEFAULT_MAX_CHARS}）

  <dir> 默认是工作区的 .workbuddy/memory（与 lmmarr 共用同一份冷存储）。
`;

/** 拆参数：--json 为布尔；--max / --max-entry 取下一个值；--keep 吃掉后面的全部文本。 */
function splitArgs(args) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--json') {
      flags.json = true;
    } else if (a === '--keep') {
      flags.keep = args.slice(i + 1).join(' ').trim();
      break;
    } else if (a === '--max' || a === '--max-entry') {
      const v = Number(args[++i]);
      if (Number.isFinite(v)) flags[a.slice(2)] = v;
    } else if (a.startsWith('--')) {
      flags[a.slice(2)] = true;
    } else {
      pos.push(a);
    }
  }
  return { pos, flags };
}

function emitJson(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
  process.exit(0);
}

function runJournal(args) {
  const { pos, flags } = splitArgs(args);
  const [dir, taskId, sub] = pos;
  if (!dir || !taskId || !sub) {
    failUsage('journal 需要 <dir> <taskId> <子命令>', 'add / resolve / next / show，见 `node cli.js help`');
  }
  assertTaskId(taskId);

  const limit = Number.isFinite(flags['max-entry']) ? flags['max-entry'] : undefined;
  const state = loadJournal(dir, taskId);

  // 读命令：直接出内容
  if (sub === 'show') {
    if (flags.json) emitJson({ ok: true, taskId, journal: journalPath(dir, taskId), state });
    process.stdout.write(renderJournal(state));
    process.exit(0);
  }

  if (sub === 'add') {
    const kind = pos[3];
    const text = pos.slice(4).join(' ');
    if (!kind || !text) {
      failUsage('add 需要 <did|pit|open> <文本>', '例：add did "改 main.py 加重复惩罚 → 5 条断言通过"');
    }
    const entry = addEntry(state, kind, text, limit);
    const file = saveJournal(dir, state);
    if (flags.json) emitJson({ ok: true, entry, file });
    const c = countByKind(state);
    ok(`journal 追加 #${entry.seq} ${entry.kind}`, {
      file,
      seq: entry.seq,
      did: c.did,
      pit: c.pit,
      open: c.open,
    });
  }

  if (sub === 'resolve') {
    const seq = pos[3];
    if (!seq) {
      failUsage('resolve 需要 <序号>', '序号就是条目里的 #N，见 `journal <taskId> show`');
    }
    if (!flags.keep) {
      failUsage(
        'resolve 必须给 --keep <总结文本>',
        '原报错会被丢弃，所以必须写出「特征 + 处理法」。把总结写在 --keep 后面（可含空格）',
      );
    }
    const r = resolveEntry(state, seq, flags.keep, {
      into: flags.into ?? 'pit',
      maxChars: limit,
    });
    const file = saveJournal(dir, state);
    if (flags.json) emitJson({ ok: true, seq: r.entry.seq, kind: r.entry.kind, dropped: true, file });
    const c = countByKind(state);
    ok(`#${r.entry.seq} 已降级为 ${r.entry.kind}（原报错已丢弃）`, {
      file,
      seq: r.entry.seq,
      open: c.open,
    });
  }

  if (sub === 'next') {
    const text = pos.slice(3).join(' ');
    if (!text) failUsage('next 需要 <文本>', '例：next "补 smoke_test 第 4 例"');
    setNext(state, text, limit);
    const file = saveJournal(dir, state);
    if (flags.json) emitJson({ ok: true, next: state.next, file });
    ok('next 已更新', { file, next: state.next });
  }

  failUsage(`未知子命令: ${sub}`, 'add / resolve / next / show');
}

function runBrief(args) {
  const { pos, flags } = splitArgs(args);
  const [dir, taskId] = pos;
  if (!dir || !taskId) {
    failUsage('brief 需要 <dir> <taskId> [关键词...]', '例：brief .workbuddy/memory api-retry 熔断 重试');
  }
  assertTaskId(taskId);

  const keywords = pos.slice(2);
  const maxChars = Number.isFinite(flags.max) ? flags.max : DEFAULT_MAX_CHARS;

  const doc = loadTaskDoc(dir, taskId);
  const state = loadJournal(dir, taskId);
  const task = doc ?? { id: taskId, title: taskId, status: '', progress: 0, summary: '' };
  const brief = composeBrief({ task, state, keywords, maxChars });

  if (flags.json) {
    emitJson({
      ok: true,
      taskId,
      chars: brief.length,
      maxChars,
      taskFound: Boolean(doc),
      taskFile: taskPath(dir, taskId),
      journalFound: state.entries.length > 0,
      brief,
    });
  }

  process.stdout.write(brief + '\n');
  process.exit(0);
}

function handle(err) {
  const msg = err instanceof Error ? err.message : String(err);
  // 带 code 的是 IO 类错误（ENOENT/EACCES/EISDIR…），与「参数不对」区分开
  if (err && err.code) {
    fail(`执行失败: ${msg}`, '检查目录是否存在、是否有写权限', process.env.LMMARR_DEBUG ? err.stack : undefined);
  }
  failUsage(msg, '用 `node cli.js help` 看用法');
}

const argv = process.argv.slice(2);
const cmd = argv[0];

try {
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    process.stdout.write(USAGE);
    process.exit(0);
  }
  if (!cmd) {
    // 无参数不是一次成功的调用：打印用法，退出码 2（便于安装后的冒烟检查）
    process.stdout.write(USAGE);
    process.exit(2);
  }
  if (cmd === 'journal') runJournal(argv.slice(1));
  else if (cmd === 'brief') runBrief(argv.slice(1));
  else failUsage(`未知命令: ${cmd}`, '支持 journal / brief，见 `node cli.js help`');
} catch (err) {
  handle(err);
}
