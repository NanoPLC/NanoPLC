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
  scan_index: number;
  elapsed_ms: number;
  /** Named variables (DI symbols, internal wires, DO symbols). */
  vars: Record<string, boolean | number>;
  di: boolean[];
  ai: number[];
  do: boolean[];
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
}
