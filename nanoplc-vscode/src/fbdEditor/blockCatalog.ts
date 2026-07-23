/** Block metadata for the FBD canvas editor (mirrors compiler-supported types). */

export const CONST_DATA_TYPES = ["BOOL", "INT", "DINT", "UINT", "WORD", "REAL"] as const;
export type ConstDataType = (typeof CONST_DATA_TYPES)[number];

export interface FbdBlockParamDef {
  key: string;
  label: string;
  /** `channel` renders as a device I/O channel dropdown in the editor. */
  type?: "string" | "number" | "channel" | "boolean" | "plc_type" | "const_value";
  default?: string | number | boolean;
}

export interface FbdBlockDef {
  type: string;
  label: string;
  category: "io" | "logic" | "timer";
  inputs: string[];
  outputs: string[];
  params?: FbdBlockParamDef[];
}

export const FBD_BLOCK_CATALOG: FbdBlockDef[] = [
  {
    type: "DI",
    label: "Digital In",
    category: "io",
    inputs: [],
    outputs: ["Q"],
    params: [{ key: "channel", label: "Module / channel", type: "channel" }],
  },
  {
    type: "AI",
    label: "Analog In",
    category: "io",
    inputs: [],
    outputs: ["Q"],
    params: [{ key: "channel", label: "Module / channel", type: "channel" }],
  },
  {
    type: "DO",
    label: "Digital Out",
    category: "io",
    inputs: ["IN"],
    outputs: [],
    params: [{ key: "channel", label: "Module / channel", type: "channel" }],
  },
  { type: "AND", label: "AND", category: "logic", inputs: ["IN1", "IN2"], outputs: ["Q"] },
  { type: "OR", label: "OR", category: "logic", inputs: ["IN1", "IN2"], outputs: ["Q"] },
  { type: "NOT", label: "NOT", category: "logic", inputs: ["IN"], outputs: ["Q"] },
  {
    type: "CONST",
    label: "Constant",
    category: "logic",
    inputs: [],
    outputs: ["Q"],
    params: [
      { key: "data_type", label: "Type", type: "plc_type", default: "BOOL" },
      { key: "value", label: "Value", type: "const_value", default: false },
    ],
  },
  {
    type: "TON",
    label: "TON",
    category: "timer",
    inputs: ["IN"],
    outputs: ["Q"],
    params: [{ key: "pt_ms", label: "PT (ms)", type: "number", default: 1000 }],
  },
];

export function findBlockDef(type: string): FbdBlockDef | undefined {
  return FBD_BLOCK_CATALOG.find((b) => b.type === type.toUpperCase());
}

export function defaultBlockParams(type: string): Record<string, string | number | boolean> {
  const def = findBlockDef(type);
  if (!def?.params) {
    return {};
  }
  const params: Record<string, string | number | boolean> = {};
  for (const p of def.params) {
    if (p.default !== undefined) {
      params[p.key] = p.default;
    }
  }
  return params;
}
