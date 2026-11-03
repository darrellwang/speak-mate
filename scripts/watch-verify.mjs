/**
 * 真机验证观测脚本（scripts/watch-verify.mjs）
 *
 * 用途：主人用真机/开发者工具操作小程序时，这个脚本在终端实时打印
 *       后端收到的请求 + users 表里的账号变化，帮忙定位问题。
 *
 * 用法：
 *   node scripts/watch-verify.mjs            # 持续监控（Ctrl+C 退出）
 *   node scripts/watch-verify.mjs --once     # 只打印一次当前状态
 *
 * 观测点：
 *   1. 服务日志尾部（每次请求的路径与状态码）
 *   2. users 表（微信登录成功会新增一行，nickname 是随机生成的）
 *   3. 各用户的业务数据量（验证数据隔离）
 */
import { readFileSync, watch } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const BackendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'backend');
// ⚠️ 必须从 backend/ 解析 better-sqlite3：根目录 node_modules 里那份是用
// 沙箱 Node（NODE_MODULE_VERSION 127）编译的，与系统 Node 24（137）不兼容，
// 直接 require 会报 ERR_DLOPEN_FAILED。
const Database = require(path.join(BackendDir, 'node_modules', 'better-sqlite3'));

const DB_PATH = path.join(BackendDir, 'data', 'speakmate.db');
const LOG_PATH = path.join(BackendDir, 'data', 'speakmate-service.log');
const ONCE = process.argv.includes('--once');

/** 读取 users 表 */
function readUsers() {
  const db = new Database(DB_PATH, { readonly: true });
  try {
    return db
      .prepare(
        `SELECT u.id, u.source, u.nickname, u.created_at, u.last_login_at,
                (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id) AS sessions,
                (SELECT COUNT(*) FROM vocabulary v WHERE v.user_id = u.id) AS words
         FROM users u ORDER BY u.created_at DESC`,
      )
      .all();
  } finally {
    db.close();
  }
}

/** 读取 admin 账号的存量数据量（迁移前的历史数据） */
function readAdminCounts() {
  const db = new Database(DB_PATH, { readonly: true });
  try {
    const s = db.prepare(`SELECT COUNT(*) c FROM sessions WHERE user_id = 'admin'`).get();
    const m = db.prepare(`SELECT COUNT(*) c FROM messages WHERE user_id = 'admin'`).get();
    return { sessions: s.c, messages: m.c };
  } finally {
    db.close();
  }
}

/** 读日志尾部 N 行 */
function tailLog(n = 12) {
  try {
    const raw = readFileSync(LOG_PATH, 'utf8');
    return raw.split('\n').filter((l) => l.trim() !== '').slice(-n);
  } catch {
    return ['(日志文件不可读)'];
  }
}

function printState() {
  const users = readUsers();
  const admin = readAdminCounts();
  console.log('─'.repeat(66));
  console.log(`账号列表（共 ${users.length} 个）`);
  console.log('─'.repeat(66));
  for (const u of users) {
    console.log(
      `  ${u.id.padEnd(24)} ${String(u.source).padEnd(7)} ${String(u.nickname).padEnd(12)}` +
        ` 会话=${String(u.sessions).padStart(2)} 词条=${String(u.words).padStart(2)}`,
    );
  }
  console.log(
    `\n  [admin 存量数据] 会话 ${admin.sessions} / 消息 ${admin.messages}` +
      '  ← 迁移前的历史数据应归在这里',
  );
  console.log('─'.repeat(66));
  console.log('最近请求日志：');
  for (const line of tailLog(10)) {
    console.log(`  ${line}`);
  }
  console.log('');
}

console.log('SpeakMate 真机验证观测器');
console.log(`数据库: ${DB_PATH}`);
console.log('按 Ctrl+C 退出\n');

printState();

if (!ONCE) {
  // 轮询模式：每 2 秒检查日志是否有新内容
  let lastSize = 0;
  try {
    lastSize = readFileSync(LOG_PATH, 'utf8').length;
  } catch {
    /* ignore */
  }
  setInterval(() => {
    let size = 0;
    try {
      size = readFileSync(LOG_PATH, 'utf8').length;
    } catch {
      return;
    }
    if (size !== lastSize) {
      lastSize = size;
      const users = readUsers();
      const newest = users[0];
      console.log(`[${new Date().toLocaleTimeString('zh-CN')}] 有新请求`);
      for (const line of tailLog(4)) {
        console.log(`  ${line}`);
      }
      if (newest) {
        console.log(
          `  当前最新账号: ${newest.id} / ${newest.nickname} / 会话=${newest.sessions} 词条=${newest.words}`,
        );
      }
      console.log('');
    }
  }, 2000);
}
