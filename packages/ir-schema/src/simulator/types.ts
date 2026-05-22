export interface TonInstanceState {
  et_ms: number;
  q: boolean;
}

export interface SimulatorSnapshot {
  scan_index: number;
  elapsed_ms: number;
  /** Named variables (DI symbols, internal wires, DO symbols). */
  vars: Record<string, boolean | number>;
  di: boolean[];
  do: boolean[];
}

export interface SimState {
  vars: Record<string, boolean | number>;
  di: boolean[];
  do: boolean[];
  ton: Map<string, TonInstanceState>;
  scan_index: number;
  elapsed_ms: number;
}
