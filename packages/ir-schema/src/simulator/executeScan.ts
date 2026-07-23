import type { PlcIr, ScheduleStep } from "../types";
import type { SimState, SimulatorSnapshot, TonInstanceState } from "./types";

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

function tonState(state: SimState, blockId: string): TonInstanceState {
  let t = state.ton.get(blockId);
  if (!t) {
    t = { et_ms: 0, q: false };
    state.ton.set(blockId, t);
  }
  return t;
}

function executeTon(state: SimState, step: ScheduleStep, dt_ms: number): void {
  const blockId = step.block_id ?? "ton";
  const t = tonState(state, blockId);
  const pt = step.pt_ms ?? 1000;
  const inn = readBool(state, step.in1);

  if (!inn) {
    t.et_ms = 0;
    t.q = false;
  } else {
    t.et_ms += dt_ms;
    t.q = t.et_ms >= pt;
  }

  writeBool(state, step.out, t.q);
  state.vars[`${blockId}.ET`] = t.et_ms;
  state.vars[`${blockId}.Q`] = t.q;
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
      const value = state.ai[idx] ?? 0;
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
    case "ton":
      executeTon(state, step, dt_ms);
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
        state.vars[step.out] = Number.isFinite(n) ? n : 0;
      }
      break;
    }
    case "move":
      if (step.out && step.in1) {
        state.vars[step.out] = state.vars[step.in1] ?? false;
      }
      break;
    default:
      break;
  }
}

export function createSimState(ir: PlcIr): SimState {
  const diLen = Math.max(0, ...ir.io_image.di.map((d) => d.index + 1), 0);
  const aiLen = Math.max(0, ...ir.io_image.ai.map((d) => d.index + 1), 0);
  const doLen = Math.max(0, ...ir.io_image.do.map((d) => d.index + 1), 0);

  const vars: Record<string, boolean | number> = {};
  for (const v of ir.variables) {
    if (v.type === "BOOL") {
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
    ton: new Map(),
    scan_index: 0,
    elapsed_ms: 0,
  };
}

export function runScan(state: SimState, ir: PlcIr, dt_ms: number): SimulatorSnapshot {
  for (const step of ir.schedule) {
    executeScheduleStep(state, step, dt_ms);
  }
  state.scan_index += 1;
  state.elapsed_ms += dt_ms;
  return snapshot(state);
}

export function snapshot(state: SimState): SimulatorSnapshot {
  return {
    scan_index: state.scan_index,
    elapsed_ms: state.elapsed_ms,
    vars: { ...state.vars },
    di: [...state.di],
    ai: [...state.ai],
    do: [...state.do],
  };
}
