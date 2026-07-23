import type { PlcIr } from "../types";
import { createSimState, runScan, snapshot } from "./executeScan";
import type { SimState, SimulatorSnapshot } from "./types";

export class PlcSimulator {
  private readonly ir: PlcIr;
  private state: SimState;
  private timer: ReturnType<typeof setInterval> | undefined;
  private listener: ((snap: SimulatorSnapshot) => void) | undefined;

  constructor(ir: PlcIr) {
    this.ir = ir;
    this.state = createSimState(ir);
  }

  get scanPeriodMs(): number {
    return this.ir.project.scan_period_ms > 0 ? this.ir.project.scan_period_ms : 10;
  }

  get running(): boolean {
    return this.timer !== undefined;
  }

  reset(): void {
    this.state = createSimState(this.ir);
    this.listener?.(snapshot(this.state));
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

  /** Run exactly one scan (useful in tests). */
  stepOnce(): SimulatorSnapshot {
    return runScan(this.state, this.ir, this.scanPeriodMs);
  }

  start(onTick: (snap: SimulatorSnapshot) => void): void {
    if (this.timer) {
      return;
    }
    this.listener = onTick;
    onTick(snapshot(this.state));
    this.timer = setInterval(() => {
      const snap = runScan(this.state, this.ir, this.scanPeriodMs);
      onTick(snap);
    }, this.scanPeriodMs);
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
