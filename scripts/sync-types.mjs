#!/usr/bin/env node
/**
 * 契约同步：shared/types/*.ts → miniprogram/types/*.d.ts
 *
 * 为什么不是直接引用 ../../shared/types：
 * 微信开发者工具会编译 miniprogramRoot 下的 **所有** .ts 文件并输出同名 .js；
 * 而 shared/types 是纯类型声明（零运行时），编译出的空 JS 纯属垃圾产物。
 * 改为同步成 `.d.ts` —— 声明文件不参与编译，TypeScript 类型检查照样解析得到。
 *
 * 用法：node scripts/sync-types.mjs（或在 miniprogram 目录执行 pnpm sync-types）
 * 约定：改完 shared/types 后必须重跑本脚本，否则小程序端类型会滞后于后端。
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(currentDir, '..');
const srcDir = path.join(repoRoot, 'shared', 'types');
const outDir = path.join(repoRoot, 'miniprogram', 'types');

/** 需要同步的契约文件（顺序无关） */
const FILES = ['models.ts', 'api.ts', 'chat.ts'];

const HEADER = `/**
 * ⚠️ 本文件由 scripts/sync-types.mjs 从 shared/types 自动生成，请勿手动编辑。
 * 唯一事实源：shared/types/（后端与 H5 前端共用同一份契约）。
 * 修改契约后请重跑：node scripts/sync-types.mjs
 */

`;

mkdirSync(outDir, { recursive: true });

let written = 0;
for (const file of FILES) {
  const source = readFileSync(path.join(srcDir, file), 'utf8');
  const target = path.join(outDir, file.replace(/\.ts$/, '.d.ts'));
  const next = HEADER + source.trim() + '\n';
  const previous = (() => {
    try {
      return readFileSync(target, 'utf8');
    } catch {
      return null;
    }
  })();
  if (previous === next) {
    continue;
  }
  writeFileSync(target, next, 'utf8');
  written += 1;
  console.log(`[sync-types] ${file} → miniprogram/types/${file.replace(/\.ts$/, '.d.ts')}`);
}

console.log(
  written === 0
    ? '[sync-types] 契约无变化，跳过写入'
    : `[sync-types] 完成，更新 ${written} 个文件`,
);
