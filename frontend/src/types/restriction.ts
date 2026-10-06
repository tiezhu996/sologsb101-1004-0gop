import type { Revisioned } from './persistence';

/** 封锁判定阈值：限速值 ≤ 0 视为封锁 */
export const BLOCK_LIMIT_KMH = 0;

/** 封锁 / 慢行条件（/backup 页登记，/workorders 编排页消费） */
export interface SpeedRestriction extends Revisioned {
  id: string;
  /** 关联站场 */
  yardId: string;
  /** 关联道岔编号（空串表示站场级，命中该站场全部道岔） */
  switchCode: string;
  /** 限速值 km/h，≤ 0 表示封锁 */
  limitKmh: number;
  /** 起止日期描述，如 2026-10-04 ~ 2026-10-11 */
  period: string;
  /** 登记原因 */
  reason: string;
  createdAt: string;
}

/** 限速条件命中结果：一条条件命中作业单涉及的若干道岔 */
export interface RestrictionHit {
  /** 命中的条件本体 */
  restriction: SpeedRestriction;
  /** 站场名称（展示用） */
  yardName: string;
  /** 命中的道岔编号 */
  switchCodes: string[];
  /** 是否站场级条件 */
  yardLevel: boolean;
  /** 是否封锁（限速 ≤ 0） */
  block: boolean;
}

/** 单张作业单的限速条件汇总 */
export interface OrderRestrictionSummary {
  /** 命中当前时间窗的全部条件（按限速从低到高排序，最严在前） */
  hits: RestrictionHit[];
  /**
   * 整单备料限速：命中条件中的最低限速。
   * 同一张单涉及几处道岔、限速不一样时，整张单按限速最低（最严）的一条准备料具；
   * 无命中为 null。
   */
  lowestLimitKmh: number | null;
  /** 命中的封锁条件（限速 ≤ 0），非空则挡住保存 */
  blockers: RestrictionHit[];
}

/** 空的限速条件汇总（已下达 / 已完成单不再回头校验时使用） */
export const EMPTY_RESTRICTION_SUMMARY: OrderRestrictionSummary = {
  hits: [],
  lowestLimitKmh: null,
  blockers: [],
};
