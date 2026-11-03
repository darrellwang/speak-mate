/**
 * 训练器领域类型（types/handbook.d.ts）
 *
 * 与 services/api.ts 不同，这份契约不跨端——只有小程序训练器用。
 * 数据源是本地 data/handbook.json（外企 IT 职场英语常用句，648 条），不走后端。
 *
 * 进度结构：
 *   { idx: { s: 'new'|'known'|'weak', star: 0|1, seen: n } }
 * 这样未来若做云同步，字段名不用改。
 */

/** 单句掌握状态：new=没练过 / known=已掌握 / weak=模糊（再来一次） */
export type HandbookMastery = 'new' | 'known' | 'weak';

/** 训练素材单条（data/handbook.json 的 items 数组元素） */
export interface HandbookItem {
  /** 分类名（中文，如「1. 问候与寒暄」） */
  cat: string;
  /** 场景子标题（中文，如「早上见面」） */
  scene: string;
  /** 中文参考译文 */
  zh: string;
  /** 英文原句（TTS 朗读 + 听写答案） */
  en: string;
}

/** 训练素材完整数据 */
export interface HandbookData {
  title: string;
  count: number;
  cats: string[];
  items: HandbookItem[];
}

/** 单条训练进度（按 items 下标 idx 索引） */
export interface HandbookProgressEntry {
  /** 掌握状态 */
  s: HandbookMastery;
  /** 收藏标记：0=否 1=是 */
  star: 0 | 1;
  /** 练习次数（next() 触发 +1） */
  seen: number;
}

/** 全量进度：{ [idx]: entry }，缺失项视为 { s:'new', star:0, seen:0 } */
export type HandbookProgress = Record<number, HandbookProgressEntry>;

/** 四种练习模式 */
export type TrainerMode = 'listen' | 'dictation' | 'shadow' | 'recall';

/** 听写 / 跟读 diff 结果的单个 token */
export interface DiffToken {
  /** 词形（已小写、去标点） */
  text: string;
  /** good=命中 / miss=答案有但用户漏写 / bad=用户多写或写错 */
  kind: 'good' | 'bad' | 'miss';
}

/**
 * 训练范围筛选
 *
 * star = 已收藏（与掌握状态正交：一句被收藏时，它仍可能是 new/weak/known 之一）
 */
export type TrainerScope = 'all' | 'new' | 'weak' | 'known' | 'star';

/** 训练顺序 */
export type TrainerOrder = 'seq' | 'random';
