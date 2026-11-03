/**
 * 入参校验工具（审查报告 L2：分页校验在 sessions / words 两个路由中重复实现且规则不一致）
 *
 * 统一收口分页参数解析，避免两处规则漂移（原 words 路由未校验 limit 是否为整数）。
 */

import type { Request } from 'express';
import { badRequest } from './error';

export interface PaginationOptions {
  /** limit 的 query 键名（如 msg_limit） */
  limitKey?: string;
  /** offset 的 query 键名（如 msg_offset） */
  offsetKey?: string;
  /** 未传 limit 时的默认值 */
  defaultLimit: number;
  /** limit 上限，防止单次拉取过多 */
  maxLimit: number;
}

export interface Pagination {
  limit: number;
  offset: number;
}

/**
 * 解析并校验分页参数。
 *
 * 校验规则：limit ∈ [1, maxLimit]（非整数向下取整）；offset 必须为非负整数。
 * 任一不合法 → 抛 1001。
 */
export function parsePagination(
  query: Record<string, unknown>,
  opts: PaginationOptions,
): Pagination {
  const limitKey = opts.limitKey ?? 'limit';
  const offsetKey = opts.offsetKey ?? 'offset';
  const limitRaw = query[limitKey] === undefined ? opts.defaultLimit : Number(query[limitKey]);
  const offsetRaw = query[offsetKey] === undefined ? 0 : Number(query[offsetKey]);
  if (
    !Number.isFinite(limitRaw) ||
    !Number.isFinite(offsetRaw) ||
    !Number.isInteger(offsetRaw) ||
    limitRaw < 1 ||
    limitRaw > opts.maxLimit ||
    offsetRaw < 0
  ) {
    throw badRequest(`分页参数非法（${limitKey} / ${offsetKey}）`);
  }
  return { limit: Math.floor(limitRaw), offset: offsetRaw };
}

/** 取 req.query 的宽松字典视图（Express 的 query 类型为 ParsedQs，此处仅供校验使用） */
export function queryOf(req: Request): Record<string, unknown> {
  return req.query as Record<string, unknown>;
}
