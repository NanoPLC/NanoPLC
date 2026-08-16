import type { CompileDiagnostic, FbdVariable, PlcPrimitiveType, PlcVarClass } from "./types";
import { PLC_PRIMITIVE_TYPES, PLC_VAR_CLASSES } from "./types";

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function isPlcVarClass(value: unknown): value is PlcVarClass {
  return typeof value === "string" && (PLC_VAR_CLASSES as readonly string[]).includes(value);
}

export function pouIrName(programId: string, varName: string): string {
  return `${programId}__${varName}`;
}

export function callPortIrName(blockId: string, port: string): string {
  return `__${blockId}_${port}`;
}

export function defaultPouInitial(type: PlcPrimitiveType): boolean | number {
  return type === "BOOL" ? false : 0;
}

export function normalizePouInitial(
  type: PlcPrimitiveType,
  value: unknown
): boolean | number {
  if (type === "BOOL") {
    if (typeof value === "boolean") {
      return value;
    }
    if (typeof value === "number") {
      return value !== 0;
    }
    if (typeof value === "string") {
      const s = value.trim().toLowerCase();
      return s === "true" || s === "1" || s === "on";
    }
    return false;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return type === "REAL" ? value : Math.trunc(value);
  }
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) {
      return type === "REAL" ? n : Math.trunc(n);
    }
  }
  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }
  return 0;
}

export function findPouVariable(
  vars: FbdVariable[] | undefined,
  name: string
): FbdVariable | undefined {
  const key = name.trim().toUpperCase();
  return (vars ?? []).find((v) => v.name.toUpperCase() === key);
}

export function pouInterfaceInputs(vars: FbdVariable[] | undefined): FbdVariable[] {
  return (vars ?? []).filter((v) => v.class === "IN" || v.class === "IN_OUT");
}

export function pouInterfaceOutputs(vars: FbdVariable[] | undefined): FbdVariable[] {
  return (vars ?? []).filter((v) => v.class === "OUT" || v.class === "IN_OUT");
}

/** Ports shown on a CALL box: IN + IN_OUT on the left, OUT + IN_OUT on the right. */
export function callBlockPorts(vars: FbdVariable[] | undefined): {
  inputs: string[];
  outputs: string[];
} {
  return {
    inputs: pouInterfaceInputs(vars).map((v) => v.name),
    outputs: pouInterfaceOutputs(vars).map((v) => v.name),
  };
}

export function localBlockPorts(variable: FbdVariable | undefined): {
  inputs: string[];
  outputs: string[];
} {
  if (!variable) {
    return { inputs: [], outputs: [] };
  }
  switch (variable.class) {
    case "IN":
      return { inputs: [], outputs: ["Q"] };
    case "OUT":
      return { inputs: ["IN"], outputs: [] };
    default:
      return { inputs: ["IN"], outputs: ["Q"] };
  }
}

export function parsePouVariables(raw: unknown): {
  variables: FbdVariable[];
  diagnostics: CompileDiagnostic[];
} {
  const diagnostics: CompileDiagnostic[] = [];
  if (raw === undefined) {
    return { variables: [], diagnostics };
  }
  if (!Array.isArray(raw)) {
    return {
      variables: [],
      diagnostics: [
        {
          code: "NP-0218",
          message: "Program variables must be an array.",
          severity: "error",
        },
      ],
    };
  }

  const variables: FbdVariable[] = [];
  const seen = new Set<string>();

  for (const item of raw) {
    if (item == null || typeof item !== "object") {
      diagnostics.push({
        code: "NP-0218",
        message: "Each program variable must be an object.",
        severity: "error",
      });
      continue;
    }
    const o = item as Record<string, unknown>;
    const name = typeof o.name === "string" ? o.name.trim() : "";
    if (!name || !IDENT.test(name)) {
      diagnostics.push({
        code: "NP-0216",
        message: `Invalid variable name "${name || String(o.name ?? "")}". Use a letter or underscore, then letters, digits, or underscores.`,
        severity: "error",
      });
      continue;
    }
    const key = name.toUpperCase();
    if (seen.has(key)) {
      diagnostics.push({
        code: "NP-0217",
        message: `Duplicate program variable "${name}".`,
        severity: "error",
      });
      continue;
    }
    seen.add(key);

    if (!isPlcVarClass(o.class)) {
      diagnostics.push({
        code: "NP-0218",
        message: `Variable "${name}" class must be IN, IN_OUT, OUT, VAR, or TEMP.`,
        severity: "error",
      });
      continue;
    }
    const typeRaw = typeof o.type === "string" ? o.type.toUpperCase() : "";
    if (!(PLC_PRIMITIVE_TYPES as readonly string[]).includes(typeRaw)) {
      diagnostics.push({
        code: "NP-0218",
        message: `Variable "${name}" type must be one of: ${PLC_PRIMITIVE_TYPES.join(", ")}.`,
        severity: "error",
      });
      continue;
    }
    const type = typeRaw as PlcPrimitiveType;
    const variable: FbdVariable = { name, class: o.class, type };
    if (o.initial !== undefined) {
      variable.initial = normalizePouInitial(type, o.initial);
    }
    variables.push(variable);
  }

  return { variables, diagnostics };
}

export function nextPouVarName(className: PlcVarClass, existing: FbdVariable[]): string {
  const prefix =
    className === "IN_OUT" ? "InOut" : className === "TEMP" ? "Temp" : className.charAt(0) + className.slice(1).toLowerCase();
  const taken = new Set(existing.map((v) => v.name.toUpperCase()));
  let n = 1;
  while (taken.has(`${prefix}${n}`.toUpperCase())) {
    n++;
  }
  return `${prefix}${n}`;
}
