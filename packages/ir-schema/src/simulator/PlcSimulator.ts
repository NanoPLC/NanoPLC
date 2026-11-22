import { irPrimaryPeriodMs, irTaskList, irTaskPeriodMs } from "../irTasks";
import { VirtualPlant } from "../plant/VirtualPlant";
import type { VirtualPlantConfig } from "../plant/types";
import type { IrEventSource, IrTask, PlcIr } from "../types";
import { createSimState, runTaskPass, snapshot } from "./executeScan";
import type { SimIoCapacity, SimState, SimulatorSnapshot } from "./types";

export { FREEWHEEL_PERIOD_MS } from "../irTasks";

interface SimTask {
  task: IrTask;
  /** Cyclic / freewheel period; unused for event tasks. */
  period_ms: number;
  /** Next due virtual time; `Infinity` while an event task waits for an edge. */
  next_due_ms: number;
  last_run_ms?: number;
  /** Previous sample of the event trigger (event tasks only). */
  event_prev?: boolean;
}

/**
 * Deterministic Virtual PLC. Tasks run in virtual time: a cyclic task passes at
 * every multiple of `interval_ms`, a freewheeling task every `FREEWHEEL_PERIOD_MS`,
 * an event task on each rising edge of its BOOL trigger (DI or VAR).
 * Passes due at the same instant run in priority order (0 first).
 */
export class PlcSimulator {
  private readonly ir: PlcIr;
  private readonly capacity: SimIoCapacity | undefined;
  private state: SimState;
  private tasks: SimTask[];
  private plant: VirtualPlant | undefined;
  /** Virtual time the plant has already been integrated to. */
  private plantTime = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private listener: ((snap: SimulatorSnapshot) => void) | undefined;

  constructor(ir: PlcIr, capacity?: SimIoCapacity, plant?: VirtualPlantConfig) {
    this.ir = ir;
    this.capacity = capacity;
    this.state = createSimState(ir, capacity);
    this.attachPlant(plant);
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
    return irTaskList(this.ir).map((task) => {
      if (task.kind === "event") {
        return {
          task,
          period_ms: 0,
          next_due_ms: Number.POSITIVE_INFINITY,
          event_prev: this.readEventLevel(task.event_source),
        };
      }
      const period = irTaskPeriodMs(task);
      return { task, period_ms: period, next_due_ms: period };
    });
  }

  private readEventLevel(source: IrEventSource | undefined): boolean {
    if (!source) {
      return false;
    }
    if (source.kind === "di") {
      return this.state.di[source.index] === true;
    }
    const v = this.state.vars[source.name];
    return v === true || v === 1;
  }

  /** Queue event tasks whose trigger rose at virtual time `now`. */
  private sampleEventEdges(now: number): void {
    for (const t of this.tasks) {
      if (t.task.kind !== "event" || !t.task.event_source) {
        continue;
      }
      const cur = this.readEventLevel(t.task.event_source);
      if (cur && !t.event_prev) {
        t.next_due_ms = now;
      }
      t.event_prev = cur;
    }
  }

  reset(): void {
    this.state = createSimState(this.ir, this.capacity);
    this.plantTime = 0;
    this.plant?.reset();
    this.plant?.integrate(this.state, 0);
    this.tasks = this.createTasks();
    this.listener?.(this.publish());
  }

  /**
   * Replace the virtual plant without resetting PLC task state.
   * Pass `undefined` or an empty device list to detach it.
   */
  attachPlant(config: VirtualPlantConfig | undefined): void {
    this.plant = config && config.devices.length > 0 ? new VirtualPlant(config) : undefined;
    this.plantTime = this.state.elapsed_ms;
    this.plant?.integrate(this.state, 0);
    this.mirrorSensorSymbols();
  }

  /** Operator gesture on a virtual device (`"load"` places a conveyor part). */
  setPlantControl(id: string, value: boolean | number | "load"): void {
    if (!this.plant) {
      return;
    }
    this.plant.setControl(id, value, this.state);
    this.mirrorSensorSymbols();
  }

  /** Move the plant from `plantTime` to `now` using the current DO image, then publish sensors. */
  private catchUpPlant(now: number): void {
    if (!this.plant) {
      return;
    }
    const dt = now - this.plantTime;
    if (dt < 0) {
      return;
    }
    this.plant.integrate(this.state, dt);
    this.plantTime = now;
  }

  /** Keep DI/AI symbol vars aligned with the image the plant just wrote. */
  private mirrorSensorSymbols(): void {
    if (!this.plant) {
      return;
    }
    for (const entry of this.ir.io_image.di) {
      if (entry.symbol && entry.index >= 0 && entry.index < this.state.di.length) {
        this.state.vars[entry.symbol] = this.state.di[entry.index] === true;
      }
    }
    for (const entry of this.ir.io_image.ai) {
      if (entry.symbol && entry.index >= 0 && entry.index < this.state.ai.length) {
        this.state.vars[entry.symbol] = this.state.ai[entry.index] ?? 0;
      }
    }
  }

  private publish(): SimulatorSnapshot {
    const snap = snapshot(this.state);
    if (this.plant) {
      snap.plant = this.plant.snapshot(this.state);
    }
    return snap;
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

  setDo(index: number, value: boolean): void {
    if (this.state.failsafe_outputs_off) {
      return;
    }
    if (index >= 0 && index < this.state.do.length) {
      this.state.do[index] = value;
      const entry = this.ir.io_image.do.find((d) => d.index === index);
      if (entry?.symbol) {
        this.state.vars[entry.symbol] = value;
      }
    }
  }

  /**
   * Simulate a watchdog timeout for `taskId`. When the task's IR action is
   * `outputs_off`, force every DO OFF and latch (same as firmware fail-safe).
   */
  tripWatchdog(taskId: string): SimulatorSnapshot {
    const task = irTaskList(this.ir).find((t) => t.id === taskId);
    if (task?.watchdog_action === "outputs_off") {
      this.state.failsafe_outputs_off = true;
      for (let i = 0; i < this.state.do.length; i++) {
        this.state.do[i] = false;
      }
      for (const d of this.ir.io_image.do) {
        if (d.symbol) {
          this.state.vars[d.symbol] = false;
        }
      }
    }
    return this.publish();
  }

  /** Advance virtual time by `ms`, running every task pass that falls due. */
  advance(ms: number): SimulatorSnapshot {
    const target = this.state.elapsed_ms + Math.max(0, ms);
    this.catchUpPlant(this.state.elapsed_ms);
    this.sampleEventEdges(this.state.elapsed_ms);
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
      this.catchUpPlant(now);
      let dt: number;
      if (next.task.kind === "cyclic") {
        dt = next.period_ms;
      } else if (next.task.kind === "event") {
        dt = next.last_run_ms === undefined ? 0 : now - next.last_run_ms;
      } else {
        dt = now - (next.last_run_ms ?? 0);
      }
      this.state.elapsed_ms = now;
      runTaskPass(this.state, this.ir, next.task.schedule, dt);
      next.last_run_ms = now;
      if (next.task.kind === "event") {
        next.next_due_ms = Number.POSITIVE_INFINITY;
      } else {
        next.next_due_ms = now + next.period_ms;
      }
      this.state.task_passes[next.task.id] = (this.state.task_passes[next.task.id] ?? 0) + 1;
      const nonEventCount = this.tasks.filter((x) => x.task.kind !== "event").length;
      if (next.task.primary || (next.task.kind !== "event" && nonEventCount === 1)) {
        this.state.scan_index += 1;
      }
      this.sampleEventEdges(now);
    }
    this.catchUpPlant(target);
    this.mirrorSensorSymbols();
    this.state.elapsed_ms = target;
    return this.publish();
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
    onTick(this.publish());
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
    return this.publish();
  }
}
