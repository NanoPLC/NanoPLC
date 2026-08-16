import {
  FBD_SOURCE_SCHEMA_VERSION,
  IO_MAP_SCHEMA_VERSION,
  IR_VERSION,
  PROJECT_SCHEMA_VERSION,
} from "./constants";

export type PlcPrimitiveType = "BOOL" | "INT" | "DINT" | "UINT" | "WORD" | "REAL";

export const PLC_PRIMITIVE_TYPES: readonly PlcPrimitiveType[] = [
  "BOOL",
  "INT",
  "DINT",
  "UINT",
  "WORD",
  "REAL",
];

/** IEC-style variable sections on a PROGRAM. */
export const PLC_VAR_CLASSES = ["IN", "IN_OUT", "OUT", "VAR", "TEMP"] as const;
export type PlcVarClass = (typeof PLC_VAR_CLASSES)[number];

export interface FbdVariable {
  name: string;
  class: PlcVarClass;
  type: PlcPrimitiveType;
  /** Cold-start value. TEMP is reapplied at the start of every call. */
  initial?: boolean | number;
}

export interface NanoPlcProgramRef {
  id: string;
  name: string;
  source: string;
  language: "fbd" | "st" | "lad";
}

/** CODESYS-like task kinds (Task Configuration). */
export const PLC_TASK_KINDS = ["cyclic", "freewheeling", "event"] as const;
export type PlcTaskKind = (typeof PLC_TASK_KINDS)[number];

export interface NanoPlcTaskWatchdog {
  enabled: boolean;
  /** Watchdog timeout in milliseconds. */
  time_ms: number;
}

/** One PROGRAM call inside a task. Legacy; a task now has a single `program`. */
export interface NanoPlcTaskPouCall {
  /** Program id from `programs[]`. */
  program: string;
}

/**
 * PLC task — schedules one entry PROGRAM, analogous to CODESYS Task Configuration.
 * Siemens-style OB numbers are not used. Extra programs belong on other tasks, or
 * are called from a PROGRAM (FBD `CALL` block).
 */
export interface NanoPlcTaskRef {
  id: string;
  name: string;
  kind: PlcTaskKind;
  /** 0 = highest priority (CODESYS-like), 31 = lowest. */
  priority: number;
  /** Cyclic interval in milliseconds. Required when `kind` is `cyclic`. */
  interval_ms?: number;
  /** BOOL symbol that triggers an `event` task (rising edge). Runtime later. */
  event?: string;
  watchdog?: NanoPlcTaskWatchdog;
  /** Entry PROGRAM id. A task runs exactly one program. */
  program?: string;
  /**
   * Legacy call list. If present, must contain at most one entry; prefer `program`.
   * @deprecated
   */
  pous?: NanoPlcTaskPouCall[];
}

/** Field I/O module (maps to `io-map.json` or future module configs). */
export interface NanoPlcModuleRef {
  id: string;
  name: string;
  type: "gpio_digital_io" | string;
  /** Relative path to module configuration (e.g. `src/io-map.json`). */
  config?: string;
}

/** Runtime driver binding a module to firmware HAL / fieldbus stack. */
export interface NanoPlcDriverRef {
  id: string;
  name: string;
  type: "nanoplc_hal" | string;
  /** Module id this driver serves. */
  binds?: string;
}

export interface NanoPlcProject {
  schema_version: typeof PROJECT_SCHEMA_VERSION;
  name: string;
  device: {
    board: string;
    idf_target: string;
    /** Device template from the IDE catalog (e.g. `m5stack.stamplc_k141`). */
    catalog_id?: string;
    vendor?: string;
    model?: string;
  };
  /**
   * Legacy single-scan period. When `tasks[]` is present, treat as a cache of the
   * primary cyclic task interval (kept so older IR/codegen keep working).
   */
  scan?: {
    period_ms: number;
  };
  /** Optional I/O modules (default: onboard GPIO when omitted). */
  modules?: NanoPlcModuleRef[];
  /** Optional HAL / fieldbus drivers (default: `nanoplc_hal` when omitted). */
  drivers?: NanoPlcDriverRef[];
  /**
   * CODESYS-style Task Configuration. When omitted, the IDE synthesizes MainTask
   * from `scan.period_ms` and the first program.
   */
  tasks?: NanoPlcTaskRef[];
  programs: NanoPlcProgramRef[];
  firmware_root?: string;
}

export interface FbdPortRef {
  block: string;
  port: string;
}

export interface FbdWire {
  from: FbdPortRef;
  to: FbdPortRef;
}

export interface FbdBlock {
  id: string;
  type: string;
  params?: Record<string, string | number | boolean>;
}

export interface FbdSource {
  schema_version: typeof FBD_SOURCE_SCHEMA_VERSION;
  name: string;
  blocks: FbdBlock[];
  wires: FbdWire[];
  /** PROGRAM variable declarations (IN, IN_OUT, OUT, VAR, TEMP). */
  variables?: FbdVariable[];
  /** Optional editor canvas positions (ignored by IR compiler). */
  layout?: Record<string, { x: number; y: number }>;
}

export interface IoMapEntry {
  symbol: string;
  kind: "DI" | "DO" | "AI";
  index: number;
  gpio?: number;
  active_high?: boolean;
}

export interface IoMap {
  schema_version: typeof IO_MAP_SCHEMA_VERSION;
  entries: IoMapEntry[];
}

export interface IrVariable {
  name: string;
  type: PlcPrimitiveType;
  role: "internal" | "di" | "do" | "ai" | "fb_state";
  initial?: boolean | number;
}

export interface IrIoImage {
  di: { symbol: string; index: number }[];
  do: { symbol: string; index: number }[];
  ai: { symbol: string; index: number }[];
}

export type ScheduleOp =
  | "read_di"
  | "read_ai"
  | "write_do"
  | "and"
  | "or"
  | "not"
  | "move"
  | "ton"
  | "const"
  | "add"
  | "sub"
  | "mul"
  | "div"
  | "pow"
  | "sqrt"
  | "setbit"
  | "resetbit"
  | "shl"
  | "shr"
  | "rol"
  | "ror"
  | "rs"
  | "call";

export interface ScheduleStep {
  step: number;
  op: ScheduleOp;
  /** Primary output or target variable name. */
  out?: string;
  in1?: string;
  in2?: string;
  symbol?: string;
  index?: number;
  /** Block instance id for FB ops (e.g. TON). */
  block_id?: string;
  pt_ms?: number;
  /** Literal value for `const` ops. */
  value?: boolean | number;
  /** PLC type of the `const` literal / destination. */
  value_type?: PlcPrimitiveType;
  /** Callee program id for `call` ops. */
  program?: string;
  /** Caller wire names for callee IN / IN_OUT ports (`port → source`). */
  call_in?: Record<string, string>;
  /** Caller dest names for callee OUT / IN_OUT ports (`port → dest`). */
  call_out?: Record<string, string>;
}

export interface PlcIr {
  ir_version: typeof IR_VERSION;
  project: {
    name: string;
    board: string;
    scan_period_ms: number;
    program: string;
  };
  variables: IrVariable[];
  io_image: IrIoImage;
  network: {
    blocks: FbdBlock[];
    wires: FbdWire[];
  };
  instances: { id: string; type: string; params?: Record<string, unknown> }[];
  schedule: ScheduleStep[];
  /** Callee PROGRAM schedules invoked by `call` ops in `schedule` (and nested calls). */
  pou_schedules?: { id: string; schedule: ScheduleStep[] }[];
}

export interface CompileDiagnostic {
  code: string;
  message: string;
  block_id?: string;
  /** Program id when the diagnostic belongs to a specific POU. */
  program_id?: string;
  severity: "error" | "warning";
}

export interface CompileResult {
  ok: boolean;
  ir?: PlcIr;
  diagnostics: CompileDiagnostic[];
}

export {
  FBD_SOURCE_SCHEMA_VERSION,
  IO_MAP_SCHEMA_VERSION,
  IR_VERSION,
  PROJECT_SCHEMA_VERSION,
};
