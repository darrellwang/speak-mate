/**
 * 展示格式化工具：时间。
 * 后端时间一律 ISO 8601 UTC 字符串（架构文档 §4.1），此处按本地时区渲染中文格式。
 */

/** 完整时间：9月5日 14:30（跨年时补上年份） */
export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const now = new Date();
  const sameYear = date.getFullYear() === now.getFullYear();
  const md = `${date.getMonth() + 1}月${date.getDate()}日`;
  const hm = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  return sameYear ? `${md} ${hm}` : `${date.getFullYear()}年${md} ${hm}`;
}
