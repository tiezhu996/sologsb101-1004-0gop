/**
 * 封锁 / 慢行条件与天窗作业单的匹配
 * 编排（建单 / 改单）时顺着 病害 → 巡检 → 道岔 → 站场 找出命中时间窗的限速条件：
 * - 站场级条件（未指定道岔）命中该站场全部道岔，道岔级条件只命中对应道岔
 * - 限速为 0 视为封锁，时间窗与封锁时段相交即拦截保存
 * - 一单涉及多处道岔限速不一致时，整单按最低（最严）一条限速统一备料具
 */
import type {
  FaultRow,
  InspectionRow,
  SpeedRestrictionRow,
  SwitchRow,
  YardRow,
} from './db';

/** 命中作业单时间窗的一条限速 / 封锁条件 */
export interface RestrictionHit {
  restrictionId: string;
  yardId: string;
  yardName: string;
  /** 条件登记的道岔编号，空串表示站场级 */
  switchCode: string;
  scope: 'yard' | 'switch';
  limitKmh: number;
  period: string;
  reason: string;
  /** 限速为 0 视为封锁 */
  blocked: boolean;
  /** 本单内命中该条件的道岔编号 */
  hitSwitchCodes: string[];
}

/** 解析条件时段「yyyy-MM-dd ~ yyyy-MM-dd」，非法格式返回 null */
export function parsePeriod(period: string): { start: string; end: string } | null {
  const parts = period.split('~').map((item) => item.trim());
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  return { start: parts[0], end: parts[1] };
}

/**
 * 条件时段与天窗时间窗是否相交。
 * 条件按日期粒度登记（起止日期当天全天有效），故按日期区间比较，
 * 端点相接（窗口起止日落在条件起止日上）也算相交。
 */
export function restrictionHitsWindow(period: string, windowStart: string, windowEnd: string): boolean {
  const range = parsePeriod(period);
  if (!range) return false;
  const startDay = windowStart.slice(0, 10);
  const endDay = windowEnd.slice(0, 10);
  if (!startDay || !endDay) return false;
  return startDay <= range.end && range.start <= endDay;
}

export interface OrderRestrictionInput {
  faultIds: string[];
  windowStart: string;
  windowEnd: string;
}

export interface OrderRestrictionData {
  faults: FaultRow[];
  inspections: InspectionRow[];
  switches: SwitchRow[];
  yards: YardRow[];
  restrictions: SpeedRestrictionRow[];
}

/**
 * 顺着作业单的关联病害找到所属道岔与站场，列出命中当前时间窗的
 * 站场级 / 道岔级限速条件（按限速值升序，最严的在前）。
 */
export function findOrderRestrictionHits(
  input: OrderRestrictionInput,
  data: OrderRestrictionData,
): RestrictionHit[] {
  const switchIds = new Set<string>();
  for (const faultId of input.faultIds) {
    const fault = data.faults.find((item) => item.id === faultId);
    if (!fault) continue;
    const inspection = data.inspections.find((item) => item.id === fault.inspectionId);
    if (inspection) switchIds.add(inspection.switchId);
  }
  const involved = data.switches.filter((item) => switchIds.has(item.id));

  const hits = new Map<string, RestrictionHit>();
  for (const switchRow of involved) {
    for (const restriction of data.restrictions) {
      if (restriction.yardId !== switchRow.yardId) continue;
      const switchCode = restriction.switchCode.trim();
      const scope: RestrictionHit['scope'] = switchCode === '' ? 'yard' : 'switch';
      if (scope === 'switch' && switchCode !== switchRow.code) continue;
      if (!restrictionHitsWindow(restriction.period, input.windowStart, input.windowEnd)) continue;
      const existing = hits.get(restriction.id);
      if (existing) {
        if (!existing.hitSwitchCodes.includes(switchRow.code)) existing.hitSwitchCodes.push(switchRow.code);
        continue;
      }
      hits.set(restriction.id, {
        restrictionId: restriction.id,
        yardId: switchRow.yardId,
        yardName: data.yards.find((item) => item.id === switchRow.yardId)?.name ?? '',
        switchCode,
        scope,
        limitKmh: restriction.limitKmh,
        period: restriction.period,
        reason: restriction.reason,
        blocked: restriction.limitKmh <= 0,
        hitSwitchCodes: [switchRow.code],
      });
    }
  }
  return [...hits.values()].sort((a, b) => a.limitKmh - b.limitKmh);
}

/**
 * 整单执行限速：取命中条件中限速最低（最严）的一条，整单按它统一备料具；
 * 若按各处分别准备，最严的那处会被放松，作业会按低于要求的限速备机具。
 * 无命中条件时返回 null。
 */
export function effectiveOrderLimit(hits: RestrictionHit[]): number | null {
  if (hits.length === 0) return null;
  return Math.min(...hits.map((item) => item.limitKmh));
}

/** 命中的封锁条件（限速 0） */
export function blockedHits(hits: RestrictionHit[]): RestrictionHit[] {
  return hits.filter((item) => item.blocked);
}

/** 单条命中条件的展示文案 */
export function describeHit(hit: RestrictionHit): string {
  const target = hit.scope === 'yard' ? '站场级' : hit.switchCode;
  const limit = hit.blocked ? '封锁' : `限速 ${hit.limitKmh} km/h`;
  return `${hit.yardName} · ${target} · ${limit} · ${hit.period} · ${hit.reason}`;
}
