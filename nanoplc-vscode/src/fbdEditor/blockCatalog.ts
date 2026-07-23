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
  description: string;
  category: "io" | "logic" | "timer" | "math" | "bit";
  inputs: string[];
  outputs: string[];
  params?: FbdBlockParamDef[];
}

export const FBD_BLOCK_CATALOG: FbdBlockDef[] = [
  {
    type: "DI",
    label: "Digital In",
    description: "Reads a digital input channel from the device I/O map.",
    category: "io",
    inputs: [],
    outputs: ["Q"],
    params: [{ key: "channel", label: "Module / channel", type: "channel" }],
  },
  {
    type: "AI",
    label: "Analog In",
    description: "Reads an analog input channel and outputs a REAL value.",
    category: "io",
    inputs: [],
    outputs: ["Q"],
    params: [{ key: "channel", label: "Module / channel", type: "channel" }],
  },
  {
    type: "DO",
    label: "Digital Out",
    description: "Writes the input signal to a digital output channel.",
    category: "io",
    inputs: ["IN"],
    outputs: [],
    params: [{ key: "channel", label: "Module / channel", type: "channel" }],
  },
  {
    type: "AND",
    label: "AND",
    description: "Logical AND: output is TRUE when all inputs are TRUE.",
    category: "logic",
    inputs: ["IN1", "IN2"],
    outputs: ["Q"],
  },
  {
    type: "OR",
    label: "OR",
    description: "Logical OR: output is TRUE when any input is TRUE.",
    category: "logic",
    inputs: ["IN1", "IN2"],
    outputs: ["Q"],
  },
  {
    type: "NOT",
    label: "NOT",
    description: "Logical NOT: inverts the input signal.",
    category: "logic",
    inputs: ["IN"],
    outputs: ["Q"],
  },
  {
    type: "RS",
    label: "RS",
    description: "Reset-dominant bistable: SET latches TRUE, RESET1 forces FALSE.",
    category: "logic",
    inputs: ["SET", "RESET1"],
    outputs: ["Q"],
  },
  {
    type: "CONST",
    label: "Constant",
    description: "Outputs a fixed BOOL or numeric value of the selected type.",
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
    description: "On-delay timer: output turns on after input stays TRUE for PT milliseconds.",
    category: "timer",
    inputs: ["IN"],
    outputs: ["Q"],
    params: [{ key: "pt_ms", label: "PT (ms)", type: "number", default: 1000 }],
  },
  {
    type: "ADD",
    label: "ADD",
    description: "Adds two numeric inputs and outputs the result.",
    category: "math",
    inputs: ["IN1", "IN2"],
    outputs: ["Q"],
  },
  {
    type: "SUB",
    label: "SUB",
    description: "Subtracts IN2 from IN1 and outputs the difference.",
    category: "math",
    inputs: ["IN1", "IN2"],
    outputs: ["Q"],
  },
  {
    type: "MUL",
    label: "MUL",
    description: "Multiplies two numeric inputs and outputs the product.",
    category: "math",
    inputs: ["IN1", "IN2"],
    outputs: ["Q"],
  },
  {
    type: "DIV",
    label: "DIV",
    description: "Divides IN1 by IN2 and outputs the quotient.",
    category: "math",
    inputs: ["IN1", "IN2"],
    outputs: ["Q"],
  },
  {
    type: "POW",
    label: "POW",
    description: "Raises IN1 to the power of IN2 and outputs a REAL result.",
    category: "math",
    inputs: ["IN1", "IN2"],
    outputs: ["Q"],
  },
  {
    type: "SQRT",
    label: "SQRT",
    description: "Outputs the square root of the input as a REAL value.",
    category: "math",
    inputs: ["IN"],
    outputs: ["Q"],
  },
  {
    type: "SETBIT",
    label: "SETBIT",
    description: "Sets bit N in the input word and outputs the updated value.",
    category: "bit",
    inputs: ["IN", "BIT"],
    outputs: ["Q"],
  },
  {
    type: "RESETBIT",
    label: "RESETBIT",
    description: "Clears bit N in the input word and outputs the updated value.",
    category: "bit",
    inputs: ["IN", "BIT"],
    outputs: ["Q"],
  },
  {
    type: "SHL",
    label: "SHL",
    description: "Shifts the input word left by N bits.",
    category: "bit",
    inputs: ["IN", "N"],
    outputs: ["Q"],
  },
  {
    type: "SHR",
    label: "SHR",
    description: "Shifts the input word right by N bits.",
    category: "bit",
    inputs: ["IN", "N"],
    outputs: ["Q"],
  },
  {
    type: "ROL",
    label: "ROL",
    description: "Rotates the input word left by N bits.",
    category: "bit",
    inputs: ["IN", "N"],
    outputs: ["Q"],
  },
  {
    type: "ROR",
    label: "ROR",
    description: "Rotates the input word right by N bits.",
    category: "bit",
    inputs: ["IN", "N"],
    outputs: ["Q"],
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
