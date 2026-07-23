import type { FbdBlock, FbdSource, FbdWire, PlcPrimitiveType } from "./types";
import { PLC_PRIMITIVE_TYPES } from "./types";

const MATH_BLOCKS = new Set(["ADD", "SUB", "MUL", "DIV"]);
const REAL_MATH_BLOCKS = new Set(["POW", "SQRT"]);
const BIT_BLOCKS = new Set(["SETBIT", "RESETBIT", "SHL", "SHR", "ROL", "ROR"]);
const BOOL_BLOCKS = new Set(["AND", "OR", "NOT", "TON", "RS"]);

const NUMERIC_RANK: Record<PlcPrimitiveType, number> = {
  BOOL: 0,
  WORD: 1,
  UINT: 2,
  INT: 3,
  DINT: 4,
  REAL: 5,
};

export interface FbdPortTypes {
  outputs: Record<string, PlcPrimitiveType>;
  inputs: Record<string, Record<string, PlcPrimitiveType>>;
}

export function parseConstDataType(params: FbdBlock["params"]): PlcPrimitiveType {
  const raw = String(params?.data_type ?? params?.type ?? "BOOL").toUpperCase();
  if ((PLC_PRIMITIVE_TYPES as readonly string[]).includes(raw)) {
    return raw as PlcPrimitiveType;
  }
  return "BOOL";
}

function isNumericType(type: PlcPrimitiveType): boolean {
  return type !== "BOOL";
}

function unifyNumericTypes(a: PlcPrimitiveType, b: PlcPrimitiveType): PlcPrimitiveType {
  return NUMERIC_RANK[a] >= NUMERIC_RANK[b] ? a : b;
}

function findWireTo(blockId: string, port: string, wires: FbdWire[]): FbdWire | undefined {
  const p = port.toUpperCase();
  return wires.find((w) => w.to.block === blockId && w.to.port.toUpperCase() === p);
}

function inferOutputTypeForBlock(
  blockId: string,
  blocks: Map<string, FbdBlock>,
  wires: FbdWire[],
  memo: Map<string, PlcPrimitiveType>,
  visiting: Set<string>
): PlcPrimitiveType {
  if (memo.has(blockId)) {
    return memo.get(blockId)!;
  }
  if (visiting.has(blockId)) {
    return "REAL";
  }
  visiting.add(blockId);

  const block = blocks.get(blockId);
  if (!block) {
    visiting.delete(blockId);
    return "BOOL";
  }

  const t = block.type.toUpperCase();
  let result: PlcPrimitiveType;

  if (t === "CONST") {
    result = parseConstDataType(block.params);
  } else if (t === "AI") {
    result = "REAL";
  } else if (REAL_MATH_BLOCKS.has(t)) {
    result = "REAL";
  } else if (MATH_BLOCKS.has(t)) {
    const in1 = inferWiredSourceType(blockId, "IN1", blocks, wires, memo, visiting);
    const in2 = inferWiredSourceType(blockId, "IN2", blocks, wires, memo, visiting);
    result = unifyNumericTypes(in1, in2);
  } else if (BIT_BLOCKS.has(t)) {
    result = inferWiredSourceType(blockId, "IN", blocks, wires, memo, visiting);
    if (result === "BOOL" || result === "REAL") {
      result = "WORD";
    }
  } else {
    result = "BOOL";
  }

  visiting.delete(blockId);
  memo.set(blockId, result);
  return result;
}

function inferWiredSourceType(
  blockId: string,
  port: string,
  blocks: Map<string, FbdBlock>,
  wires: FbdWire[],
  memo: Map<string, PlcPrimitiveType>,
  visiting: Set<string>
): PlcPrimitiveType {
  const block = blocks.get(blockId);
  const t = block?.type.toUpperCase() ?? "";
  const wire = findWireTo(blockId, port, wires);
  if (!wire) {
    if (MATH_BLOCKS.has(t) || REAL_MATH_BLOCKS.has(t)) {
      return "REAL";
    }
    if (BIT_BLOCKS.has(t)) {
      return "WORD";
    }
    if (port.toUpperCase() === "BIT" || port.toUpperCase() === "N") {
      return "INT";
    }
    return "BOOL";
  }
  return inferOutputTypeForBlock(wire.from.block, blocks, wires, memo, visiting);
}

export function buildBlockOutputTypes(
  blocks: Map<string, FbdBlock>,
  wires: FbdWire[]
): Map<string, PlcPrimitiveType> {
  const memo = new Map<string, PlcPrimitiveType>();
  const visiting = new Set<string>();
  for (const id of blocks.keys()) {
    inferOutputTypeForBlock(id, blocks, wires, memo, visiting);
  }
  return memo;
}

export function inferInputPortType(
  block: FbdBlock,
  port: string,
  outputTypes: Map<string, PlcPrimitiveType>
): PlcPrimitiveType {
  const t = block.type.toUpperCase();
  const p = port.toUpperCase();

  if (t === "DO" || BOOL_BLOCKS.has(t)) {
    return "BOOL";
  }
  if (REAL_MATH_BLOCKS.has(t)) {
    return "REAL";
  }
  if (MATH_BLOCKS.has(t) && (p === "IN1" || p === "IN2")) {
    return outputTypes.get(block.id) ?? "REAL";
  }
  if (BIT_BLOCKS.has(t)) {
    if (p === "BIT" || p === "N") {
      return "INT";
    }
    if (p === "IN") {
      return outputTypes.get(block.id) ?? "WORD";
    }
  }
  return "BOOL";
}

export function typesCompatible(fromType: PlcPrimitiveType, toType: PlcPrimitiveType): boolean {
  if (fromType === toType) {
    return true;
  }
  if (isNumericType(fromType) && isNumericType(toType)) {
    return unifyNumericTypes(fromType, toType) === toType;
  }
  return false;
}

export function inputPortsForType(type: string): Set<string> {
  switch (type.toUpperCase()) {
    case "DI":
    case "AI":
    case "CONST":
      return new Set();
    case "DO":
      return new Set(["IN"]);
    case "AND":
    case "OR":
      return new Set(["IN1", "IN2"]);
    case "NOT":
      return new Set(["IN"]);
    case "TON":
      return new Set(["IN"]);
    case "RS":
      return new Set(["SET", "RESET1"]);
    case "ADD":
    case "SUB":
    case "MUL":
    case "DIV":
    case "POW":
      return new Set(["IN1", "IN2"]);
    case "SQRT":
      return new Set(["IN"]);
    case "SETBIT":
    case "RESETBIT":
      return new Set(["IN", "BIT"]);
    case "SHL":
    case "SHR":
    case "ROL":
    case "ROR":
      return new Set(["IN", "N"]);
    default:
      return new Set();
  }
}

export function inferFbdPortTypes(fbd: FbdSource): FbdPortTypes {
  const blocks = new Map(fbd.blocks.map((b) => [b.id, b]));
  const outputTypesMap = buildBlockOutputTypes(blocks, fbd.wires);

  const outputs: Record<string, PlcPrimitiveType> = {};
  for (const [id, type] of outputTypesMap) {
    outputs[id] = type;
  }

  const inputs: Record<string, Record<string, PlcPrimitiveType>> = {};
  for (const block of fbd.blocks) {
    const ports = inputPortsForType(block.type);
    if (ports.size === 0) {
      continue;
    }
    const portTypes: Record<string, PlcPrimitiveType> = {};
    for (const port of ports) {
      portTypes[port] = inferInputPortType(block, port, outputTypesMap);
    }
    inputs[block.id] = portTypes;
  }

  return { outputs, inputs };
}
