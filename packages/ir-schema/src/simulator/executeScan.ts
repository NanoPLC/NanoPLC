import type { PlcIr, PlcPrimitiveType, ScheduleStep } from "../types";
import type {
  RsInstanceState,
  SimIoCapacity,
  SimState,
  SimulatorSnapshot,
  TimerInstanceState,
} from "./types";
import { pouIrName } from "../pouVars";

function readBool(state: SimState, name: string | undefined): boolean {
  if (!name) {
    return false;
  }
  const v = state.vars[name];
  return v === true || v === 1;
}

function writeBool(state: SimState, name: string | undefined, value: boolean): void {
  if (!name) {
    return;
  }
  state.vars[name] = value;
}

function readNumeric(state: SimState, name: string | undefined): number {
  if (!name) {
    return 0;
  }
  const v = state.vars[name];
  if (typeof v === "number") {
    return v;
  }
  if (typeof v === "boolean") {
    return v ? 1 : 0;
  }
  return 0;
}

function writeNumeric(
  state: SimState,
  name: string | undefined,
  value: number,
  type?: PlcPrimitiveType
): void {
  if (!name) {
    return;
  }
  state.vars[name] = type === "REAL" ? Math.fround(value) : value;
}

function bitMask(type: PlcPrimitiveType | undefined): number {
  return type === "DINT" ? 31 : 15;
}

/**
 * Store `v` the way the C runtime would: REAL as float32, integers truncated
 * toward zero and wrapped to their two's-complement width.
 */
function toInt(v: number, type: PlcPrimitiveType | undefined): number {
  if (type === "REAL") {
    return Math.fround(v);
  }
  const n = Number.isFinite(v) ? Math.trunc(v) : 0;
  switch (type) {
    case "DINT":
      return n | 0;
    case "INT":
      return (n << 16) >> 16;
    default:
      return n & 0xffff;
  }
}

function timerState(state: SimState, blockId: string): TimerInstanceState {
  let t = state.timers.get(blockId);
  if (!t) {
    t = { et_ms: 0, q: false, in_prev: false };
    state.timers.set(blockId, t);
  }
  return t;
}

function rsState(state: SimState, blockId: string): RsInstanceState {
  let r = state.rs.get(blockId);
  if (!r) {
    r = { q: false };
    state.rs.set(blockId, r);
  }
  return r;
}

/** ET advances by the pass Δt and saturates at PT (see docs/BLOCK_SEMANTICS.md). */
function advanceEt(et_ms: number, dt_ms: number, pt_ms: number): number {
  return Math.min(et_ms + dt_ms, pt_ms);
}

function executeTimer(state: SimState, step: ScheduleStep, dt_ms: number): void {
  const blockId = step.block_id ?? step.op;
  const t = timerState(state, blockId);
  const pt = step.pt_ms ?? 1000;
  const inn = readBool(state, step.in1);

  switch (step.op) {
    case "ton":
      if (inn) {
        t.et_ms = advanceEt(t.et_ms, dt_ms, pt);
        t.q = t.et_ms >= pt;
      } else {
        t.et_ms = 0;
        t.q = false;
      }
      break;
    case "tof":
      if (inn) {
        t.et_ms = 0;
        t.q = true;
      } else if (t.q) {
        t.et_ms = advanceEt(t.et_ms, dt_ms, pt);
        t.q = t.et_ms < pt;
      }
      break;
    case "tp":
      if (!t.q && inn && !t.in_prev) {
        t.q = true;
        t.et_ms = 0;
      }
      if (t.q) {
        t.et_ms = advanceEt(t.et_ms, dt_ms, pt);
        t.q = t.et_ms < pt;
      } else if (!inn) {
        t.et_ms = 0;
      }
      break;
    default:
      break;
  }
  t.in_prev = inn;

  writeBool(state, step.out, t.q);
  state.vars[`${blockId}.ET`] = t.et_ms;
  state.vars[`${blockId}.Q`] = t.q;
}

function executeRs(state: SimState, step: ScheduleStep): void {
  const blockId = step.block_id ?? "rs";
  const r = rsState(state, blockId);
  const set = readBool(state, step.in1);
  const reset1 = readBool(state, step.in2);

  if (reset1) {
    r.q = false;
  } else if (set) {
    r.q = true;
  }

  writeBool(state, step.out, r.q);
  state.vars[`${blockId}.Q`] = r.q;
}

function executeNumericBinOp(
  state: SimState,
  step: ScheduleStep,
  op: (a: number, b: number) => number
): void {
  const t = step.value_type ?? "REAL";
  const a = readNumeric(state, step.in1);
  const b = readNumeric(state, step.in2);
  writeNumeric(state, step.out, toInt(op(a, b), t), t);
}

function intMul(a: number, b: number, t: PlcPrimitiveType | undefined): number {
  return t === "REAL" ? a * b : Math.imul(a, b);
}

function executeShift(
  state: SimState,
  step: ScheduleStep,
  op: "shl" | "shr"
): void {
  const t = step.value_type ?? "WORD";
  const v = toInt(readNumeric(state, step.in1), t);
  const n = readNumeric(state, step.in2) & bitMask(t);
  const unsigned = t === "DINT" ? v >>> 0 : v & 0xffff;
  const result = op === "shl" ? unsigned << n : unsigned >>> n;
  writeNumeric(state, step.out, toInt(result, t), t);
}

function executeRotate(
  state: SimState,
  step: ScheduleStep,
  op: "rol" | "ror"
): void {
  const t = step.value_type ?? "WORD";
  const width = t === "DINT" ? 32 : 16;
  const mask = bitMask(t);
  let v = toInt(readNumeric(state, step.in1), t) >>> 0;
  if (width === 16) {
    v &= 0xffff;
  }
  const n = readNumeric(state, step.in2) & mask;
  const back = (width - n) & mask;
  const result = op === "rol" ? (v << n) | (v >>> back) : (v >>> n) | (v << back);
  writeNumeric(state, step.out, toInt(result, t), t);
}

function executeBitSet(state: SimState, step: ScheduleStep, set: boolean): void {
  const t = step.value_type ?? "WORD";
  const v = toInt(readNumeric(state, step.in1), t);
  const bit = readNumeric(state, step.in2) & bitMask(t);
  const result = set ? v | (1 << bit) : v & ~(1 << bit);
  writeNumeric(state, step.out, toInt(result, t), t);
}

export function executeScheduleStep(state: SimState, step: ScheduleStep, dt_ms: number): void {
  switch (step.op) {
    case "read_di": {
      const idx = step.index ?? 0;
      writeBool(state, step.out ?? step.symbol, state.di[idx] ?? false);
      break;
    }
    case "read_ai": {
      const idx = step.index ?? 0;
      const value = Math.fround(state.ai[idx] ?? 0);
      if (step.out ?? step.symbol) {
        state.vars[step.out ?? step.symbol!] = value;
      }
      break;
    }
    case "write_do": {
      const value = readBool(state, step.in1);
      const idx = step.index ?? 0;
      state.do[idx] = value;
      if (step.symbol) {
        writeBool(state, step.symbol, value);
      }
      break;
    }
    case "and":
      writeBool(state, step.out, readBool(state, step.in1) && readBool(state, step.in2));
      break;
    case "or":
      writeBool(state, step.out, readBool(state, step.in1) || readBool(state, step.in2));
      break;
    case "not":
      writeBool(state, step.out, !readBool(state, step.in1));
      break;
    case "rs":
      executeRs(state, step);
      break;
    case "ton":
    case "tof":
    case "tp":
      executeTimer(state, step, dt_ms);
      break;
    case "const": {
      if (!step.out) {
        break;
      }
      const t = step.value_type ?? "BOOL";
      if (t === "BOOL") {
        writeBool(state, step.out, step.value === true || step.value === 1);
      } else {
        const n = typeof step.value === "number" ? step.value : Number(step.value);
        state.vars[step.out] = toInt(Number.isFinite(n) ? n : 0, t);
      }
      break;
    }
    case "move":
      if (step.out && step.in1) {
        state.vars[step.out] = state.vars[step.in1] ?? false;
      }
      break;
    case "add":
      executeNumericBinOp(state, step, (a, b) => a + b);
      break;
    case "sub":
      executeNumericBinOp(state, step, (a, b) => a - b);
      break;
    case "mul":
      executeNumericBinOp(state, step, (a, b) => intMul(a, b, step.value_type ?? "REAL"));
      break;
    case "div":
      executeNumericBinOp(state, step, (a, b) => (b !== 0 ? a / b : 0));
      break;
    case "pow":
      writeNumeric(state, step.out, Math.pow(readNumeric(state, step.in1), readNumeric(state, step.in2)), "REAL");
      break;
    case "sqrt":
      writeNumeric(state, step.out, Math.sqrt(readNumeric(state, step.in1)), "REAL");
      break;
    case "setbit":
      executeBitSet(state, step, true);
      break;
    case "resetbit":
      executeBitSet(state, step, false);
      break;
    case "shl":
      executeShift(state, step, "shl");
      break;
    case "shr":
      executeShift(state, step, "shr");
      break;
    case "rol":
      executeRotate(state, step, "rol");
      break;
    case "ror":
      executeRotate(state, step, "ror");
      break;
    case "call":
      break;
    default:
      break;
  }
}

function imageLength(entries: { index: number }[], extra?: number): number {
  const fromIr = entries.reduce((max, entry) => Math.max(max, entry.index + 1), 0);
  return Math.max(fromIr, extra ?? 0);
}

export function createSimState(ir: PlcIr, capacity?: SimIoCapacity): SimState {
  const diLen = imageLength(ir.io_image.di, capacity?.di);
  const aiLen = imageLength(ir.io_image.ai, capacity?.ai);
  const doLen = imageLength(ir.io_image.do, capacity?.do);

  const vars: Record<string, boolean | number> = {};
  for (const v of ir.variables) {
    if (v.initial !== undefined) {
      vars[v.name] = v.initial;
    } else if (v.type === "BOOL") {
      vars[v.name] = false;
    } else {
      vars[v.name] = 0;
    }
  }

  return {
    vars,
    di: Array.from({ length: diLen }, () => false),
    ai: Array.from({ length: aiLen }, () => 0),
    do: Array.from({ length: doLen }, () => false),
    timers: new Map(),
    rs: new Map(),
    scan_index: 0,
    elapsed_ms: 0,
    task_passes: {},
  };
}

export function runScan(state: SimState, ir: PlcIr, dt_ms: number): SimulatorSnapshot {
  executeSteps(state, ir.schedule, ir, dt_ms, []);
  state.scan_index += 1;
  state.elapsed_ms += dt_ms;
  return snapshot(state);
}

/** Run one pass of a task's schedule with that task's Δt (no clock or counter updates). */
export function runTaskPass(state: SimState, ir: PlcIr, schedule: ScheduleStep[], dt_ms: number): void {
  executeSteps(state, schedule, ir, dt_ms, []);
}

function executeSteps(
  state: SimState,
  steps: ScheduleStep[],
  ir: PlcIr,
  dt_ms: number,
  callStack: string[]
): void {
  for (const step of steps) {
    if (step.op === "call") {
      const target = step.program;
      if (!target || callStack.includes(target)) {
        continue;
      }
      const pou = ir.pou_schedules?.find((p) => p.id === target);
      if (!pou) {
        continue;
      }
      for (const [port, src] of Object.entries(step.call_in ?? {})) {
        const dest = pouIrName(target, port);
        state.vars[dest] = state.vars[src] ?? false;
      }
      executeSteps(state, pou.schedule, ir, dt_ms, [...callStack, target]);
      for (const [port, dest] of Object.entries(step.call_out ?? {})) {
        const src = pouIrName(target, port);
        state.vars[dest] = state.vars[src] ?? false;
      }
      continue;
    }
    executeScheduleStep(state, step, dt_ms);
  }
}

export function snapshot(state: SimState): SimulatorSnapshot {
  return {
    scan_index: state.scan_index,
    elapsed_ms: state.elapsed_ms,
    task_passes: { ...state.task_passes },
    vars: { ...state.vars },
    di: [...state.di],
    ai: [...state.ai],
    do: [...state.do],
  };
}
