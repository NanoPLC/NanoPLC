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

export interface NanoPlcProgramRef {
  id: string;
  name: string;
  source: string;
  language: "fbd" | "st" | "lad";
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
  scan: {
    period_ms: number;
  };
  /** Optional I/O modules (default: onboard GPIO when omitted). */
  modules?: NanoPlcModuleRef[];
  /** Optional HAL / fieldbus drivers (default: `nanoplc_hal` when omitted). */
  drivers?: NanoPlcDriverRef[];
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
  /** Optional editor canvas positions (ignored by IR compiler). */
  layout?: Record<string, { x: number; y: number }>;
}

export interface IoMapEntry {
  symbol: string;
  kind: "DI" | "DO";
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
  role: "internal" | "di" | "do" | "fb_state";
}

export interface IrIoImage {
  di: { symbol: string; index: number }[];
  do: { symbol: string; index: number }[];
}

export type ScheduleOp =
  | "read_di"
  | "write_do"
  | "and"
  | "or"
  | "not"
  | "move"
  | "ton"
  | "const";

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
}

export interface CompileDiagnostic {
  code: string;
  message: string;
  block_id?: string;
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
