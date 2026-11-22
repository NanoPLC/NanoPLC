import { irPrimaryPeriodMs, irTaskList, irTaskPeriodMs } from "../irTasks";
import type { IrTask, PlcIr } from "../types";
import { createSimState, runTaskPass, snapshot } from "./executeScan";
import type { SimIoCapacity, SimState, SimulatorSnapshot } from "./types";

export { FREEWHEEL_PERIOD_MS } from "../irTasks";

interface SimTask {
  task: IrTask;
  period_ms: number;
  next_due_ms: number;
  last_run_ms?: number;
}

/**
 * Deterministic Virtual PLC. Tasks run in virtual time: a cyclic task passes at
 * every multiple of `interval_ms`, a freewheeling task every `FREEWHEEL_PERIOD_MS`.
 * Passes due at the same instant run in priority order (0 first). Event tasks
 * are not scheduled yet (T2).
 */
export class PlcSimulator {
  private readonly ir: PlcIr;
  private readonly capacity: SimIoCapacity | undefined;
  private state: SimState;
  private tasks: SimTask[];
  private timer: ReturnType<typeof setInterval> | undefined;
  private listener: ((snap: SimulatorSnapshot) => void) | undefined;

  constructor(ir: PlcIr, capacity?: SimIoCapacity) {
    this.ir = ir;
    this.capacity = capacity;
    this.state = createSimState(ir, capacity);
    this.tasks = this.createTasks();
  }

  /** Interval of the primary cyclic task (one `stepOnce`). */
  get scanPeriodMs(): number {
    return irPrimaryPeriodMs(this.ir);
  }

  get running(): boolean {
    return this.timer !== undefined;
  }

  private createTasks(): SimTask[] {
    return irTaskList(this.ir)
      .filter((task) => task.kind !== "event")
      .map((task) => {
        const period = irTaskPeriodMs(task);
        return { task, period_ms: period, next_due_ms: period };
      });
  }

  reset(): void {
    this.state = createSimState(this.ir, this.capacity);
    this.tasks = this.createTasks();
    this.listener?.(snapshot(this.state));
  }

  setVar(name: string, value: boolean | number): void {
    this.state.vars[name] = value;
  }

  setDi(index: number, value: boolean): void {
    if (index >= 0 && index < this.state.di.length) {
      this.state.di[index] = value;
    }
  }

  setDiBySymbol(symbol: string, value: boolean): void {
    const entry = this.ir.io_image.di.find((d) => d.symbol === symbol);
    if (entry) {
      this.setDi(entry.index, value);
    }
  }

  setAi(index: number, value: number): void {
    if (index >= 0 && index < this.state.ai.length) {
      this.state.ai[index] = value;
    }
  }

  setAiBySymbol(symbol: string, value: number): void {
    const entry = this.ir.io_image.ai.find((d) => d.symbol === symbol);
    if (entry) {
      this.setAi(entry.index, value);
    }
  }

  /** Advance virtual time by `ms`, running every task pass that falls due. */
  advance(ms: number): SimulatorSnapshot {
    const target = this.state.elapsed_ms + Math.max(0, ms);
    for (;;) {
      let next: SimTask | undefined;
      for (const t of this.tasks) {
        if (t.next_due_ms > target) {
          continue;
        }
        if (
          !next ||
          t.next_due_ms < next.next_due_ms ||
          (t.next_due_ms === next.next_due_ms && t.task.priority < next.task.priority)
        ) {
          next = t;
        }
      }
      if (!next) {
        break;
      }
      const now = next.next_due_ms;
      const dt = next.task.kind === "cyclic" ? next.period_ms : now - (next.last_run_ms ?? 0);
      this.state.elapsed_ms = now;
      runTaskPass(this.state, this.ir, next.task.schedule, dt);
      next.last_run_ms = now;
      next.next_due_ms = now + next.period_ms;
      this.state.task_passes[next.task.id] = (this.state.task_passes[next.task.id] ?? 0) + 1;
      if (next.task.primary || this.tasks.length === 1) {
        this.state.scan_index += 1;
      }
    }
    this.state.elapsed_ms = target;
    return snapshot(this.state);
  }

  /** Advance by one primary-task interval (useful in tests). */
  stepOnce(): SimulatorSnapshot {
    return this.advance(this.scanPeriodMs);
  }

  start(onTick: (snap: SimulatorSnapshot) => void): void {
    if (this.timer) {
      return;
    }
    this.listener = onTick;
    onTick(snapshot(this.state));
    const tick = this.scanPeriodMs;
    this.timer = setInterval(() => {
      onTick(this.advance(tick));
    }, tick);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.listener = undefined;
  }

  currentSnapshot(): SimulatorSnapshot {
    return snapshot(this.state);
  }
}
