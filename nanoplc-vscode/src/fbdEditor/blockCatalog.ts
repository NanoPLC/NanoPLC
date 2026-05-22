/** Block metadata for the FBD canvas editor (mirrors compiler-supported types). */

export interface FbdBlockParamDef {
  key: string;
  label: string;
  type?: "string" | "number";
  default?: string | number;
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
    params: [{ key: "symbol", label: "Symbol", type: "string", default: "DI_New" }],
  },
  {
    type: "DO",
    label: "Digital Out",
    category: "io",
    inputs: ["IN"],
    outputs: [],
    params: [{ key: "symbol", label: "Symbol", type: "string", default: "DO_New" }],
  },
  { type: "AND", label: "AND", category: "logic", inputs: ["IN1", "IN2"], outputs: ["Q"] },
  { type: "OR", label: "OR", category: "logic", inputs: ["IN1", "IN2"], outputs: ["Q"] },
  { type: "NOT", label: "NOT", category: "logic", inputs: ["IN"], outputs: ["Q"] },
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
