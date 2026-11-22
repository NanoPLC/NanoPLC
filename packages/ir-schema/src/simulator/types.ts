import type { PlantSnapshot } from "../plant/types";

/** State of a TON / TOF / TP instance. */
export interface TimerInstanceState {
  et_ms: number;
  q: boolean;
  /** IN from the previous pass (TP rising-edge detection). */
  in_prev: boolean;
}

/** @deprecated Use `TimerInstanceState`. */
export type TonInstanceState = TimerInstanceState;

export interface RsInstanceState {
  q: boolean;
}

export interface SimulatorSnapshot {
  /** Passes of the primary cyclic task. */
  scan_index: number;
  /** Virtual time in ms. */
  elapsed_ms: number;
  /** Passes per task id (multi-task IR). */
  task_passes: Record<string, number>;
  /** Named variables (DI symbols, internal wires, DO symbols). */
  vars: Record<string, boolean | number>;
  di: boolean[];
  ai: number[];
  do: boolean[];
  /** Watchdog fail-safe latched (`outputs_off`). */
  failsafe_outputs_off?: boolean;
  /** Virtual plant widgets. Present only when a plant is attached. */
  plant?: PlantSnapshot;
}

/** Optional process-image lengths (device I/O map may be larger than compiled IR). */
export interface SimIoCapacity {
  di?: number;
  ai?: number;
  do?: number;
}

export interface SimState {
  vars: Record<string, boolean | number>;
  di: boolean[];
  ai: number[];
  do: boolean[];
  timers: Map<string, TimerInstanceState>;
  rs: Map<string, RsInstanceState>;
  scan_index: number;
  elapsed_ms: number;
  task_passes: Record<string, number>;
  /** After watchdog `outputs_off`, DO writes are ignored until reset. */
  failsafe_outputs_off: boolean;
}
