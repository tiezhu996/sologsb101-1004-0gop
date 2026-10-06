/**
 * 封锁 / 慢行条件匹配：顺着作业单的关联病害 → 巡检 → 道岔 → 站场，
 * 找出站场级（不指定道岔）与道岔级限速条件中命中作业单时间窗的部分。
 * 多处道岔限速不一样时，整张单按限速最低（最严）的一条准备料具；
 * 限速 ≤ 0 视为封锁，时间窗与封锁时段相交即挡住保存。
 */
import type { Fault } from '../types/fault';
import type { Inspection } from '../types/inspection';
import type { Switch } from '../types/switch';
import {
  BLOCK_LIMIT_KMH,
  type OrderRestrictionSummary,
  type RestrictionHit,
  type SpeedRestriction,
} from '../types/restriction';
import { isOverlap, parseDateTime, type TimeWindow } from './window';

/** 是否封锁条件（限速 ≤ 0） */
export function isBlockRestriction(row: Pick<SpeedRestriction, 'limitKmh'>): boolean {
  return row.limitKmh <= BLOCK_LIMIT_KMH;
}

/**
 * 解析条件起止日期为时间窗：起日 00:00（含）~ 止日次日 00:00（不含），
 * 与 isOverlap 的半开区间口径一致；无法解析返回 null。
 */
export function parseRestrictionPeriod(period: string): TimeWindow | null {
  const [startText, endText] = period.split('~').map((item) => item.trim());
  if (!startText || !endText) return null;
  const start = parseDateTime(startText);
  const end = parseDateTime(endText);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  const endExclusive = new Date(end);
  endExclusive.setDate(endExclusive.getDate() + 1);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return {
    windowStart: `${startText.slice(0, 10)} 00:00`,
    windowEnd: `${endExclusive.getFullYear()}-${pad(endExclusive.getMonth() + 1)}-${pad(
      endExclusive.getDate(),
    )} 00:00`,
  };
}

/** 匹配所需的数据来源（各 slice 行记录的子集即可） */
export interface RestrictionMatchSource {
  faults: Array<Pick<Fault, 'id' | 'inspectionId'>>;
  inspections: Array<Pick<Inspection, 'id' | 'switchId'>>;
  switches: Array<Pick<Switch, 'id' | 'yardId' | 'code'>>;
  yards: Array<{ id: string; name: string }>;
  restrictions: SpeedRestriction[];
}

/**
 * 汇总一张作业单（或表单草稿）命中的限速 / 封锁条件。
 * 链路：faultIds → 病害 → 巡检 → 道岔（编号 + 所属站场）→ 条件（站场级 / 道岔级）。
 */
export function summarizeOrderRestrictions(
  target: TimeWindow & { faultIds: string[] },
  source: RestrictionMatchSource,
): OrderRestrictionSummary {
  const inspectionById = new Map(source.inspections.map((item) => [item.id, item]));
  const switchById = new Map(source.switches.map((item) => [item.id, item]));
  /** 单涉及的道岔：switchId → 编号与站场 */
  const involved = new Map<string, { code: string; yardId: string }>();
  for (const faultId of target.faultIds) {
    const fault = source.faults.find((item) => item.id === faultId);
    if (!fault) continue;
    const inspection = inspectionById.get(fault.inspectionId);
    if (!inspection) continue;
    const switchRow = switchById.get(inspection.switchId);
    if (!switchRow) continue;
    involved.set(switchRow.id, { code: switchRow.code, yardId: switchRow.yardId });
  }
  if (involved.size === 0) return { hits: [], lowestLimitKmh: null, blockers: [] };

  const yardNameOf = (yardId: string): string =>
    source.yards.find((item) => item.id === yardId)?.name ?? '未知站场';

  const hits: RestrictionHit[] = [];
  for (const restriction of source.restrictions) {
    const period = parseRestrictionPeriod(restriction.period);
    if (!period || !isOverlap(target, period)) continue;
    const switchCode = restriction.switchCode.trim();
    const yardLevel = switchCode === '';
    const matchedCodes = [...involved.values()]
      .filter((item) => item.yardId === restriction.yardId)
      .filter((item) => yardLevel || item.code === switchCode)
      .map((item) => item.code);
    if (matchedCodes.length === 0) continue;
    hits.push({
      restriction,
      yardName: yardNameOf(restriction.yardId),
      switchCodes: [...new Set(matchedCodes)].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN')),
      yardLevel,
      block: isBlockRestriction(restriction),
    });
  }
  hits.sort((a, b) => a.restriction.limitKmh - b.restriction.limitKmh);
  return {
    hits,
    lowestLimitKmh: hits.length > 0 ? Math.min(...hits.map((item) => item.restriction.limitKmh)) : null,
    blockers: hits.filter((item) => item.block),
  };
}

/** 命中条件的一句话描述（拦截提示与列表展示共用，能指出是哪条条件） */
export function describeRestrictionHit(hit: RestrictionHit): string {
  const scope = hit.yardLevel ? '站场级' : `道岔 ${hit.restriction.switchCode}`;
  const limit = hit.block ? '封锁（限速 0）' : `限速 ${hit.restriction.limitKmh} km/h`;
  return `${hit.yardName} · ${scope} · ${limit} · ${hit.restriction.period} · ${hit.restriction.reason}（命中道岔 ${hit.switchCodes.join('、')}）`;
}
