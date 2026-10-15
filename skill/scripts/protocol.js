// 执行器输出协议 —— 把「只回结论」从纪律变成结构。
//
// 用户的原始要求：
//   「不应该记录完整的路径或行动和执行结果，应该是某条指令 + 结果，中间的过程不应该保存」
//   「调试并不会变难，因为失败时再返回整段结果」（→ 双模：成功压缩，失败全量）
//
// 于是：
//   成功  → OK / KEY / DETAIL，恒定压在 10 行内，并给出「细节去哪找」的指针
//   失败  → FAIL / FIX + 全量原始信息（不截断，调试信息一点不丢）
//
// 关键点：成功态的卸载是**结构强制**的，不依赖模型自觉。
//
// 只依赖 node 内置模块。

export const MAX_OK_LINES = 10;

/**
 * 成功回执。超过 MAX_OK_LINES 时保留开头若干行与最后的 DETAIL 指针 ——
 * 结论和指针永远不能丢，被牺牲的只能是中间的 KEY 明细。
 */
export function okLines(summary, keys = {}, detail) {
  const lines = [`OK    ${summary}`];
  for (const [k, v] of Object.entries(keys)) {
    if (v === undefined || v === null || v === '') continue;
    lines.push(`KEY   ${k}=${v}`);
  }
  if (detail) lines.push(`DETAIL ${detail}`);

  if (lines.length > MAX_OK_LINES && detail) {
    const head = lines.slice(0, MAX_OK_LINES - 1);
    return [...head, lines[lines.length - 1]];
  }
  return lines.slice(0, MAX_OK_LINES);
}

/**
 * 失败回执。raw 是原始错误/输出，**不截断** —— 失败时把整段还给调用方。
 */
export function failLines(reason, fix, raw) {
  const lines = [`FAIL  ${reason}`];
  if (fix) lines.push(`FIX   ${fix}`);
  const rawText = raw === undefined || raw === null ? '' : String(raw);
  if (rawText.trim()) lines.push('', '----- raw -----', rawText.replace(/\s+$/, ''));
  return lines;
}

/** 打印成功回执并退出 0 */
export function ok(summary, keys, detail) {
  process.stdout.write(okLines(summary, keys, detail).join('\n') + '\n');
  process.exit(0);
}

/** 打印失败回执并退出 1。注意：解析/校验类错误走退出码 2，见 failUsage。 */
export function fail(reason, fix, raw) {
  process.stdout.write(failLines(reason, fix, raw).join('\n') + '\n');
  process.exit(1);
}

/** 用法错误（参数不对、非法 id、条目超限等）退出 2 —— 与「执行失败」区分开，便于 shell 分支。 */
export function failUsage(reason, fix, raw) {
  process.stdout.write(failLines(reason, fix, raw).join('\n') + '\n');
  process.exit(2);
}
