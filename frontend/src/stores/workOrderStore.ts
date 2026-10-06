/**
 * 天窗作业单状态（Redux Toolkit slice）
 * 维护作业单编排、时间窗冲突校验、人员机具占用校验与进度推进（完成回写销号）。
 */
import { createAsyncThunk, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import {
  ROW_REVISION,
  listFaults,
  listInspections,
  listRestrictions,
  listSwitches,
  listWorkOrders,
  listYards,
  putFaults,
  putWorkOrder,
  removeWorkOrder,
  type FaultRow,
  type InspectionRow,
  type SpeedRestrictionRow,
  type SwitchRow,
  type WorkOrderRow,
  type YardRow,
} from '../utils/db';
import {
  WORK_ORDER_STATE_FLOW,
  buildWorkOrderCode,
  type WorkOrderDraft,
  type WorkOrderState,
  type WorkOrderView,
} from '../types/workOrder';
import { EMPTY_RESTRICTION_SUMMARY } from '../types/restriction';
import {
  findConflicts,
  findMachineConflicts,
  findMemberConflicts,
  nowDateTime,
  windowMinutes,
} from '../utils/window';
import { describeRestrictionHit, summarizeOrderRestrictions } from '../utils/restriction';
import { emitChange } from '../utils/events';

export interface WorkOrderStateSlice {
  workOrders: WorkOrderRow[];
  faults: FaultRow[];
  inspections: InspectionRow[];
  switches: SwitchRow[];
  yards: YardRow[];
  /** 封锁 / 慢行条件（编排校验用） */
  restrictions: SpeedRestrictionRow[];
  /** 编排时勾选的病害 */
  selectedFaultIds: string[];
  loading: boolean;
  error: string;
}

const initialState: WorkOrderStateSlice = {
  workOrders: [],
  faults: [],
  inspections: [],
  switches: [],
  yards: [],
  restrictions: [],
  selectedFaultIds: [],
  loading: false,
  error: '',
};

export const loadWorkOrderData = createAsyncThunk<
  {
    workOrders: WorkOrderRow[];
    faults: FaultRow[];
    inspections: InspectionRow[];
    switches: SwitchRow[];
    yards: YardRow[];
    restrictions: SpeedRestrictionRow[];
  },
  void,
  { rejectValue: string }
>('workOrder/load', async (_arg, { rejectWithValue }) => {
  try {
    const [workOrders, faults, inspections, switches, yards, restrictions] = await Promise.all([
      listWorkOrders(),
      listFaults(),
      listInspections(),
      listSwitches(),
      listYards(),
      listRestrictions(),
    ]);
    return { workOrders, faults, inspections, switches, yards, restrictions };
  } catch (error) {
    return rejectWithValue(error instanceof Error ? error.message : '作业单读取失败');
  }
});

/** 封锁拦截：时间窗与限速 ≤ 0 的条件相交时给出指明条件的错误文案，否则返回 null */
function blockMessageOf(draft: WorkOrderDraft, state: WorkOrderStateSlice): string | null {
  const summary = summarizeOrderRestrictions(
    { windowStart: draft.windowStart, windowEnd: draft.windowEnd, faultIds: draft.faultIds },
    state,
  );
  if (summary.blockers.length === 0) return null;
  return `天窗与封锁条件相交，无法保存：${summary.blockers.map(describeRestrictionHit).join('；')}`;
}

/** 新建作业单：把勾选病害编排进同一时间窗，并回传时间窗冲突编号 */
export const createWorkOrder = createAsyncThunk<
  { created: boolean; conflicts: string[] },
  WorkOrderDraft,
  { rejectValue: string; state: { workOrder: WorkOrderStateSlice } }
>('workOrder/create', async (draft, { getState, rejectWithValue }) => {
  try {
    const state = getState().workOrder;
    // 新建单必为待编排，需做封锁校验：限速 ≤ 0 且时间窗相交即挡住保存
    const blockMessage = blockMessageOf(draft, state);
    if (blockMessage) return rejectWithValue(blockMessage);
    const conflicts = findConflicts(
      { id: 'pending', windowStart: draft.windowStart, windowEnd: draft.windowEnd },
      state.workOrders.map((item) => ({
        id: item.id,
        code: item.code,
        windowStart: item.windowStart,
        windowEnd: item.windowEnd,
      })),
    ).map((item) => item.code);

    await putWorkOrder({
      id: `wo-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      code: draft.code.trim() || buildWorkOrderCode(new Date(), state.workOrders.length + 1),
      faultIds: draft.faultIds,
      windowStart: draft.windowStart,
      windowEnd: draft.windowEnd,
      leader: draft.leader.trim(),
      machines: draft.machines,
      members: draft.members,
      state: 'planned',
      createdAt: nowDateTime(),
      updatedAt: nowDateTime(),
      revision: ROW_REVISION,
    });
    emitChange();
    return { created: true, conflicts };
  } catch (error) {
    return rejectWithValue(error instanceof Error ? error.message : '新建作业单失败');
  }
});

export const updateWorkOrder = createAsyncThunk<
  void,
  { id: string; draft: WorkOrderDraft },
  { rejectValue: string; state: { workOrder: WorkOrderStateSlice } }
>('workOrder/update', async ({ id, draft }, { getState, rejectWithValue }) => {
  try {
    const state = getState().workOrder;
    const existing = state.workOrders.find((item) => item.id === id);
    if (!existing) return;
    // 仅待编排单参与封锁校验；已下达 / 作业中 / 已完成的单不再回头校验
    if (existing.state === 'planned') {
      const blockMessage = blockMessageOf(draft, state);
      if (blockMessage) return rejectWithValue(blockMessage);
    }
    await putWorkOrder({
      ...existing,
      code: draft.code.trim(),
      faultIds: draft.faultIds,
      windowStart: draft.windowStart,
      windowEnd: draft.windowEnd,
      leader: draft.leader.trim(),
      machines: draft.machines,
      members: draft.members,
      updatedAt: nowDateTime(),
    });
    emitChange();
  } catch (error) {
    return rejectWithValue(error instanceof Error ? error.message : '更新作业单失败');
  }
});

/**
 * 推进作业单状态。
 * 推进到「已完成」时，把关联病害批量置为已销号（回写销号）。
 */
export const advanceWorkOrder = createAsyncThunk<
  { state: WorkOrderState; solvedCount: number },
  { id: string; next: WorkOrderState },
  { rejectValue: string; state: { workOrder: WorkOrderStateSlice } }
>('workOrder/advance', async ({ id, next }, { getState, rejectWithValue }) => {
  try {
    const state = getState().workOrder;
    const existing = state.workOrders.find((item) => item.id === id);
    if (!existing) return { state: next, solvedCount: 0 };
    const allowed = WORK_ORDER_STATE_FLOW[existing.state];
    if (!allowed.includes(next)) return { state: existing.state, solvedCount: 0 };

    let solvedCount = 0;
    if (next === 'done') {
      const related = state.faults.filter(
        (item) => existing.faultIds.includes(item.id) && item.state === 'pending',
      );
      if (related.length > 0) {
        await putFaults(
          related.map((item) => ({ ...item, state: 'solved' as const, solvedAt: nowDateTime() })),
        );
        solvedCount = related.length;
      }
    }
    await putWorkOrder({
      ...existing,
      state: next,
      updatedAt: nowDateTime(),
    });
    emitChange();
    return { state: next, solvedCount };
  } catch (error) {
    return rejectWithValue(error instanceof Error ? error.message : '推进作业单失败');
  }
});

export const deleteWorkOrder = createAsyncThunk<void, string, { rejectValue: string }>(
  'workOrder/delete',
  async (id, { rejectWithValue }) => {
    try {
      await removeWorkOrder(id);
      emitChange();
    } catch (error) {
      return rejectWithValue(error instanceof Error ? error.message : '删除作业单失败');
    }
  },
);

const workOrderSlice = createSlice({
  name: 'workOrder',
  initialState,
  reducers: {
    toggleFaultSelection(state, action: PayloadAction<string>) {
      const id = action.payload;
      state.selectedFaultIds = state.selectedFaultIds.includes(id)
        ? state.selectedFaultIds.filter((item) => item !== id)
        : [...state.selectedFaultIds, id];
    },
    setFaultSelection(state, action: PayloadAction<string[]>) {
      state.selectedFaultIds = action.payload;
    },
    clearFaultSelection(state) {
      state.selectedFaultIds = [];
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(loadWorkOrderData.pending, (state) => {
        state.loading = true;
        state.error = '';
      })
      .addCase(loadWorkOrderData.fulfilled, (state, action) => {
        state.loading = false;
        state.workOrders = action.payload.workOrders;
        state.faults = action.payload.faults;
        state.inspections = action.payload.inspections;
        state.switches = action.payload.switches;
        state.yards = action.payload.yards;
        state.restrictions = action.payload.restrictions;
        const validIds = new Set(action.payload.faults.map((item) => item.id));
        state.selectedFaultIds = state.selectedFaultIds.filter((id) => validIds.has(id));
      })
      .addCase(loadWorkOrderData.rejected, (state, action) => {
        state.loading = false;
        state.error = action.payload ?? '作业单读取失败';
      });
  },
});

export const { toggleFaultSelection, setFaultSelection, clearFaultSelection } = workOrderSlice.actions;
export default workOrderSlice.reducer;

interface RootLike {
  workOrder: WorkOrderStateSlice;
}

/** 作业单视图：带病害标签、时长、冲突、限速条件命中与未销号数量 */
export function selectWorkOrderViews(state: RootLike): WorkOrderView[] {
  const { workOrders, faults, inspections, switches, yards, restrictions } = state.workOrder;
  const switchIdOfFault = (fault: FaultRow): string | undefined => {
    const inspection = inspections.find((row) => row.id === fault.inspectionId);
    return inspection?.switchId;
  };
  return workOrders
    .map((order) => {
      const related = faults.filter((item) => order.faultIds.includes(item.id));
      const labels = related.map((item) => {
        const switchRow = switches.find((row) => row.id === switchIdOfFault(item));
        return `${switchRow?.code ?? '-'} ${item.part}/${item.type}`;
      });
      const yardNames = [
        ...new Set(
          related
            .map((item) => switches.find((row) => row.id === switchIdOfFault(item))?.yardId)
            .map((yardId) => yards.find((row) => row.id === yardId)?.name)
            .filter((name): name is string => Boolean(name)),
        ),
      ];
      const others = workOrders.filter((item) => item.id !== order.id);
      const conflictCodes = others
        .filter((item) => item.windowStart < order.windowEnd && order.windowStart < item.windowEnd)
        .map((item) => item.code);
      const memberConflicts = findMemberConflicts(
        { id: order.id, windowStart: order.windowStart, windowEnd: order.windowEnd, members: order.members },
        others.map((item) => ({
          id: item.id,
          code: item.code,
          windowStart: item.windowStart,
          windowEnd: item.windowEnd,
          members: item.members,
        })),
      );
      const machineConflicts = findMachineConflicts(
        { id: order.id, windowStart: order.windowStart, windowEnd: order.windowEnd, machines: order.machines },
        others.map((item) => ({
          id: item.id,
          code: item.code,
          windowStart: item.windowStart,
          windowEnd: item.windowEnd,
          machines: item.machines,
        })),
      );
      // 限速 / 封锁条件仅对待编排单计算；已下达与已完成的单不再回头校验
      const restrictionSummary =
        order.state === 'planned'
          ? summarizeOrderRestrictions(
              { windowStart: order.windowStart, windowEnd: order.windowEnd, faultIds: order.faultIds },
              { faults, inspections, switches, yards, restrictions },
            )
          : EMPTY_RESTRICTION_SUMMARY;
      return {
        ...order,
        faultLabels: labels,
        yardNames,
        durationMinutes: windowMinutes({ windowStart: order.windowStart, windowEnd: order.windowEnd }),
        conflict: conflictCodes.length > 0,
        conflictCodes,
        memberConflict: memberConflicts.length > 0,
        machineConflict: machineConflicts.length > 0,
        pendingFaultCount: related.filter((item) => item.state === 'pending').length,
        restrictionHits: restrictionSummary.hits,
        lowestLimitKmh: restrictionSummary.lowestLimitKmh,
        restrictionBlockers: restrictionSummary.blockers,
      };
    })
    .sort((a, b) => a.windowStart.localeCompare(b.windowStart));
}

/** 待编排病害（未销号且未编排） */
export function selectPlanableFaults(state: {
  workOrder: WorkOrderStateSlice;
}): Array<{ id: string; label: string; severity: string; state: string }> {
  const { faults, inspections, workOrders, switches } = state.workOrder;
  const plannedIds = new Set(workOrders.flatMap((item) => item.faultIds));
  return faults
    .filter((item) => item.state === 'pending' && !plannedIds.has(item.id))
    .map((item) => {
      const inspection = inspections.find((row) => row.id === item.inspectionId);
      const switchRow = inspection ? switches.find((row) => row.id === inspection.switchId) : undefined;
      return {
        id: item.id,
        label: `${switchRow?.code ?? '-'} · ${item.part} / ${item.type}`,
        severity: item.severity,
        state: item.state,
      };
    });
}

/** 天窗占用统计 */
export function selectWindowStats(state: RootLike): {
  total: number;
  minutes: number;
  occupationRate: number;
  conflictCount: number;
  doneCount: number;
} {
  const views = selectWorkOrderViews(state);
  const minutes = views.reduce((sum, item) => sum + item.durationMinutes, 0);
  return {
    total: views.length,
    minutes,
    occupationRate: Number(((minutes / 180) * 100).toFixed(1)),
    conflictCount: views.filter((item) => item.conflict).length,
    doneCount: views.filter((item) => item.state === 'done').length,
  };
}
