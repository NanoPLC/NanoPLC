import { IR_VERSION } from "./constants";
import type {
  CompileDiagnostic,
  CompileResult,
  FbdBlock,
  FbdSource,
  FbdWire,
  IoMap,
  IoMapEntry,
  IrVariable,
  NanoPlcProject,
  PlcIr,
  PlcPrimitiveType,
  ScheduleStep,
} from "./types";
import { PLC_PRIMITIVE_TYPES } from "./types";
import { validateFbdSource } from "./validate";

const BLOCK_OUTPUT_PORT = "Q";
const SUPPORTED_BLOCKS = new Set(["DI", "DO", "AND", "OR", "NOT", "TON", "CONST"]);

function diag(
  code: string,
  message: string,
  block_id?: string
): CompileDiagnostic {
  return { code, message, severity: "error", block_id };
}

function blockById(blocks: FbdBlock[]): Map<string, FbdBlock> {
  return new Map(blocks.map((b) => [b.id, b]));
}

function outputVar(blockId: string): string {
  return `__${blockId}_Q`;
}

function parseConstDataType(params: FbdBlock["params"]): PlcPrimitiveType {
  const raw = String(params?.data_type ?? params?.type ?? "BOOL").toUpperCase();
  if ((PLC_PRIMITIVE_TYPES as readonly string[]).includes(raw)) {
    return raw as PlcPrimitiveType;
  }
  return "BOOL";
}

function defaultConstValue(dataType: PlcPrimitiveType): boolean | number {
  return dataType === "BOOL" ? false : 0;
}

function parseBoolLike(v: unknown): boolean {
  if (typeof v === "boolean") {
    return v;
  }
  if (typeof v === "number") {
    return v !== 0;
  }
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    return s === "true" || s === "1" || s === "on";
  }
  return false;
}

function parseNumericLike(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) {
    return v;
  }
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) {
      return n;
    }
  }
  if (typeof v === "boolean") {
    return v ? 1 : 0;
  }
  return undefined;
}

function constValueInRange(dataType: PlcPrimitiveType, value: number): boolean {
  switch (dataType) {
    case "INT":
      return Number.isInteger(value) && value >= -32768 && value <= 32767;
    case "DINT":
      return Number.isInteger(value) && value >= -2147483648 && value <= 2147483647;
    case "UINT":
    case "WORD":
      return Number.isInteger(value) && value >= 0 && value <= 65535;
    case "REAL":
      return Number.isFinite(value);
    default:
      return true;
  }
}

function parseConstValue(
  params: FbdBlock["params"],
  dataType: PlcPrimitiveType
): { ok: true; value: boolean | number } | { ok: false; message: string } {
  if (dataType === "BOOL") {
    if (params?.value === undefined || params.value === null) {
      return { ok: true, value: false };
    }
    return { ok: true, value: parseBoolLike(params.value) };
  }

  if (
    params?.value === undefined ||
    params.value === null ||
    (typeof params.value === "string" && params.value.trim() === "")
  ) {
    return { ok: true, value: defaultConstValue(dataType) as number };
  }

  const num = parseNumericLike(params.value);
  if (num === undefined) {
    return { ok: false, message: `Constant value must be a number for type ${dataType}.` };
  }
  if (!constValueInRange(dataType, num)) {
    return { ok: false, message: `Constant value ${num} is out of range for type ${dataType}.` };
  }
  return { ok: true, value: dataType === "REAL" ? num : Math.trunc(num) };
}

function blockOutputType(block: FbdBlock): PlcPrimitiveType {
  if (block.type.toUpperCase() === "CONST") {
    return parseConstDataType(block.params);
  }
  return "BOOL";
}

function blockInputType(_block: FbdBlock, _port: string): PlcPrimitiveType {
  // Current FBD inputs are all BOOL (logic, timers, digital outs).
  return "BOOL";
}

function inputPortsForType(type: string): Set<string> {
  switch (type.toUpperCase()) {
    case "DI":
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
    default:
      return new Set();
  }
}

function isOutputPort(type: string, port: string): boolean {
  const u = type.toUpperCase();
  if (port.toUpperCase() === BLOCK_OUTPUT_PORT) {
    return u !== "DO";
  }
  return false;
}

function validateWires(
  blocks: Map<string, FbdBlock>,
  wires: FbdWire[]
): CompileDiagnostic[] {
  const diagnostics: CompileDiagnostic[] = [];
  for (const wire of wires) {
    const fromBlock = blocks.get(wire.from.block);
    const toBlock = blocks.get(wire.to.block);
    if (!fromBlock) {
      diagnostics.push(diag("NP-0300", `Wire references unknown block "${wire.from.block}".`));
      continue;
    }
    if (!toBlock) {
      diagnostics.push(diag("NP-0301", `Wire references unknown block "${wire.to.block}".`));
      continue;
    }
    if (!isOutputPort(fromBlock.type, wire.from.port)) {
      diagnostics.push(
        diag("NP-0302", `Port "${wire.from.port}" is not an output on block ${fromBlock.id}.`, fromBlock.id)
      );
    }
    const allowedIn = inputPortsForType(toBlock.type);
    if (!allowedIn.has(wire.to.port.toUpperCase()) && wire.to.port.toUpperCase() !== "IN") {
      if (toBlock.type.toUpperCase() === "DO" && wire.to.port.toUpperCase() !== "IN") {
        diagnostics.push(
          diag("NP-0303", `DO block expects input port IN, got "${wire.to.port}".`, toBlock.id)
        );
      } else if (!allowedIn.has(wire.to.port.toUpperCase())) {
        diagnostics.push(
          diag(
            "NP-0303",
            `Invalid input port "${wire.to.port}" on ${toBlock.type} block ${toBlock.id}.`,
            toBlock.id
          )
        );
      }
    }

    const fromType = blockOutputType(fromBlock);
    const toType = blockInputType(toBlock, wire.to.port);
    if (fromType !== toType) {
      diagnostics.push(
        diag(
          "NP-0305",
          `Type mismatch: ${fromBlock.type} output is ${fromType}, but ${toBlock.type}.${wire.to.port} expects ${toType}.`,
          toBlock.id
        )
      );
    }
  }
  return diagnostics;
}

function validateConstBlocks(blocks: FbdBlock[]): CompileDiagnostic[] {
  const diagnostics: CompileDiagnostic[] = [];
  for (const block of blocks) {
    if (block.type.toUpperCase() !== "CONST") {
      continue;
    }
    const rawType = String(block.params?.data_type ?? block.params?.type ?? "BOOL").toUpperCase();
    if (!(PLC_PRIMITIVE_TYPES as readonly string[]).includes(rawType)) {
      diagnostics.push(
        diag(
          "NP-0215",
          `Unsupported constant type "${rawType}". Use one of: ${PLC_PRIMITIVE_TYPES.join(", ")}.`,
          block.id
        )
      );
      continue;
    }
    const dataType = rawType as PlcPrimitiveType;
    const parsed = parseConstValue(block.params, dataType);
    if (!parsed.ok) {
      diagnostics.push(diag("NP-0215", parsed.message, block.id));
    }
  }
  return diagnostics;
}

/** Kahn topological sort; returns order or cycle participant ids. */
function topoSort(
  blockIds: string[],
  edges: Map<string, Set<string>>
): { order?: string[]; cycle?: string[] } {
  const inDegree = new Map<string, number>();
  for (const id of blockIds) {
    inDegree.set(id, 0);
  }
  for (const [, targets] of edges) {
    for (const t of targets) {
      inDegree.set(t, (inDegree.get(t) ?? 0) + 1);
    }
  }

  const queue = blockIds.filter((id) => (inDegree.get(id) ?? 0) === 0);
  const order: string[] = [];

  while (queue.length > 0) {
    const n = queue.shift()!;
    order.push(n);
    for (const m of edges.get(n) ?? []) {
      const d = (inDegree.get(m) ?? 0) - 1;
      inDegree.set(m, d);
      if (d === 0) {
        queue.push(m);
      }
    }
  }

  if (order.length !== blockIds.length) {
    const stuck = blockIds.filter((id) => !order.includes(id));
    return { cycle: stuck };
  }
  return { order };
}

function parseChannel(params: FbdBlock["params"]): number | undefined {
  if (params?.channel === undefined || params.channel === null) {
    return undefined;
  }
  const n = typeof params.channel === "number" ? params.channel : Number(params.channel);
  return Number.isFinite(n) && n >= 1 ? Math.trunc(n) : undefined;
}

function resolveIoSymbol(block: FbdBlock, kind: "DI" | "DO"): string {
  if (block.params?.symbol !== undefined && String(block.params.symbol).trim() !== "") {
    return String(block.params.symbol);
  }
  const channel = parseChannel(block.params);
  if (channel !== undefined) {
    return `${kind}_${channel}`;
  }
  return block.id;
}

function resolveIoIndex(
  block: FbdBlock,
  kind: "DI" | "DO",
  ioBySymbol: Map<string, IoMapEntry>,
  autoIndex: number
): { symbol: string; index: number; nextAuto: number } {
  const symbol = resolveIoSymbol(block, kind);
  const mapped = ioBySymbol.get(symbol);
  if (mapped) {
    return { symbol, index: mapped.index, nextAuto: autoIndex };
  }
  const channel = parseChannel(block.params);
  if (channel !== undefined) {
    return { symbol, index: channel - 1, nextAuto: autoIndex };
  }
  return { symbol, index: autoIndex, nextAuto: autoIndex + 1 };
}

function validateIoBindings(blocks: FbdBlock[]): CompileDiagnostic[] {
  const diagnostics: CompileDiagnostic[] = [];
  const diChannels = new Map<number, string>();
  const doChannels = new Map<number, string>();
  const diSymbols = new Map<string, string>();
  const doSymbols = new Map<string, string>();

  for (const block of blocks) {
    const t = block.type.toUpperCase();
    if (t !== "DI" && t !== "DO") {
      continue;
    }
    const channel = parseChannel(block.params);
    const label = t === "DI" ? "Digital In" : "Digital Out";

    if (channel === undefined) {
      diagnostics.push(
        diag(
          "NP-0214",
          `${label} block "${block.id}" has no I/O channel assigned. Select an input/output channel in the block properties.`,
          block.id
        )
      );
      continue;
    }

    const symbol = resolveIoSymbol(block, t);
    const channelMap = t === "DI" ? diChannels : doChannels;
    const symbolMap = t === "DI" ? diSymbols : doSymbols;

    const prev = channelMap.get(channel);
    if (prev) {
      diagnostics.push(
        diag(
          "NP-0212",
          `Duplicate ${t} channel ${channel} on blocks "${prev}" and "${block.id}".`,
          block.id
        )
      );
    } else {
      channelMap.set(channel, block.id);
    }

    const prevSym = symbolMap.get(symbol);
    if (prevSym) {
      diagnostics.push(
        diag(
          "NP-0213",
          `Duplicate ${t} symbol "${symbol}" on blocks "${prevSym}" and "${block.id}".`,
          block.id
        )
      );
    } else {
      symbolMap.set(symbol, block.id);
    }
  }

  return diagnostics;
}

function collectVariables(
  blocks: FbdBlock[],
  ioMap?: IoMap
): { variables: IrVariable[]; io_image: PlcIr["io_image"] } {
  const variables: IrVariable[] = [];
  const di: PlcIr["io_image"]["di"] = [];
  const doList: PlcIr["io_image"]["do"] = [];
  const ioBySymbol = new Map(ioMap?.entries.map((e) => [e.symbol, e]) ?? []);

  let diAuto = 0;
  let doAuto = 0;

  for (const block of blocks) {
    const t = block.type.toUpperCase();
    if (t === "DI" || t === "DO") {
      if (t === "DI") {
        const resolved = resolveIoIndex(block, "DI", ioBySymbol, diAuto);
        diAuto = resolved.nextAuto;
        di.push({ symbol: resolved.symbol, index: resolved.index });
        variables.push({ name: resolved.symbol, type: "BOOL", role: "di" });
      } else {
        const resolved = resolveIoIndex(block, "DO", ioBySymbol, doAuto);
        doAuto = resolved.nextAuto;
        doList.push({ symbol: resolved.symbol, index: resolved.index });
        variables.push({ name: resolved.symbol, type: "BOOL", role: "do" });
      }
    } else if (t === "CONST") {
      variables.push({
        name: outputVar(block.id),
        type: parseConstDataType(block.params),
        role: "internal",
      });
    } else {
      variables.push({ name: outputVar(block.id), type: "BOOL", role: "internal" });
    }
  }

  return { variables, io_image: { di, do: doList } };
}

function emitScheduleStep(
  block: FbdBlock,
  wireIns: Map<string, string>,
  io_image: PlcIr["io_image"],
  stepIndex: number
): ScheduleStep[] {
  const t = block.type.toUpperCase();
  const out = outputVar(block.id);

  switch (t) {
    case "DI": {
      const symbol = resolveIoSymbol(block, "DI");
      const entry = io_image.di.find((d) => d.symbol === symbol);
      return [
        {
          step: stepIndex,
          op: "read_di",
          symbol,
          index: entry?.index ?? 0,
          out: symbol,
        },
      ];
    }
    case "DO": {
      const symbol = resolveIoSymbol(block, "DO");
      const entry = io_image.do.find((d) => d.symbol === symbol);
      const inVar = wireIns.get("IN") ?? wireIns.get("in") ?? "";
      return [
        {
          step: stepIndex,
          op: "write_do",
          symbol,
          index: entry?.index ?? 0,
          in1: inVar,
        },
      ];
    }
    case "AND":
      return [
        {
          step: stepIndex,
          op: "and",
          in1: wireIns.get("IN1") ?? "",
          in2: wireIns.get("IN2") ?? "",
          out,
        },
      ];
    case "OR":
      return [
        {
          step: stepIndex,
          op: "or",
          in1: wireIns.get("IN1") ?? "",
          in2: wireIns.get("IN2") ?? "",
          out,
        },
      ];
    case "NOT":
      return [
        {
          step: stepIndex,
          op: "not",
          in1: wireIns.get("IN") ?? "",
          out,
        },
      ];
    case "TON": {
      const pt = block.params?.pt_ms ?? block.params?.PT ?? 1000;
      return [
        {
          step: stepIndex,
          op: "ton",
          block_id: block.id,
          in1: wireIns.get("IN") ?? "",
          out,
          pt_ms: typeof pt === "number" ? pt : Number(pt),
        },
      ];
    }
    case "CONST": {
      const dataType = parseConstDataType(block.params);
      const parsed = parseConstValue(block.params, dataType);
      return [
        {
          step: stepIndex,
          op: "const",
          out,
          value: parsed.ok ? parsed.value : defaultConstValue(dataType),
          value_type: dataType,
        },
      ];
    }
    default:
      return [];
  }
}

function wireValue(blocks: Map<string, FbdBlock>, blockId: string, port: string): string {
  const block = blocks.get(blockId);
  if (!block) {
    return "";
  }
  const t = block.type.toUpperCase();
  if (t === "DI") {
    return resolveIoSymbol(block, "DI");
  }
  if (port.toUpperCase() === BLOCK_OUTPUT_PORT) {
    return outputVar(blockId);
  }
  return outputVar(blockId);
}

export function compileFbdToIr(
  project: NanoPlcProject,
  fbdRaw: unknown,
  programId: string,
  ioMap?: IoMap
): CompileResult {
  const { fbd, diagnostics: fbdValDiags } = validateFbdSource(fbdRaw);
  const diagnostics = [...fbdValDiags];
  if (!fbd) {
    return { ok: false, diagnostics };
  }

  const blocks = blockById(fbd.blocks);
  const blockIds = fbd.blocks.map((b) => b.id);

  const dupIds = new Set<string>();
  const seen = new Set<string>();
  for (const id of blockIds) {
    if (seen.has(id)) {
      dupIds.add(id);
    }
    seen.add(id);
  }
  if (dupIds.size > 0) {
    diagnostics.push(diag("NP-0210", `Duplicate block ids: ${[...dupIds].join(", ")}.`));
  }

  for (const block of fbd.blocks) {
    if (!SUPPORTED_BLOCKS.has(block.type.toUpperCase())) {
      diagnostics.push(
        diag("NP-0211", `Unsupported block type "${block.type}".`, block.id)
      );
    }
  }

  diagnostics.push(...validateIoBindings(fbd.blocks));
  diagnostics.push(...validateConstBlocks(fbd.blocks));
  diagnostics.push(...validateWires(blocks, fbd.wires));

  const edges = new Map<string, Set<string>>();
  for (const id of blockIds) {
    edges.set(id, new Set());
  }
  for (const wire of fbd.wires) {
    if (wire.from.block === wire.to.block) {
      diagnostics.push(diag("NP-0304", "Self-loop wire is not allowed.", wire.from.block));
      continue;
    }
    edges.get(wire.from.block)?.add(wire.to.block);
  }

  const { order, cycle } = topoSort(blockIds, edges);
  if (cycle) {
    diagnostics.push(
      diag(
        "NP-0400",
        `Combinational cycle detected among blocks: ${cycle.join(", ")}. Break the loop or insert timer/latch semantics.`
      )
    );
  }

  if (diagnostics.some((d) => d.severity === "error")) {
    return { ok: false, diagnostics };
  }

  const program = project.programs.find((p) => p.id === programId);
  const { variables, io_image } = collectVariables(fbd.blocks, ioMap);

  const wireInsByBlock = new Map<string, Map<string, string>>();
  for (const wire of fbd.wires) {
    if (!wireInsByBlock.has(wire.to.block)) {
      wireInsByBlock.set(wire.to.block, new Map());
    }
    const portKey = wire.to.port.toUpperCase();
    wireInsByBlock.get(wire.to.block)!.set(portKey, wireValue(blocks, wire.from.block, wire.from.port));
  }

  const schedule: ScheduleStep[] = [];
  let stepNum = 0;
  for (const blockId of order ?? []) {
    const block = blocks.get(blockId)!;
    const ins = wireInsByBlock.get(blockId) ?? new Map();
    const steps = emitScheduleStep(block, ins, io_image, stepNum);
    for (const s of steps) {
      schedule.push({ ...s, step: stepNum++ });
    }
  }

  const instances = fbd.blocks
    .filter((b) => b.type.toUpperCase() === "TON")
    .map((b) => ({
      id: b.id,
      type: "TON",
      params: { pt_ms: b.params?.pt_ms ?? b.params?.PT ?? 1000 },
    }));

  const ir: PlcIr = {
    ir_version: IR_VERSION,
    project: {
      name: project.name,
      board: project.device.board,
      scan_period_ms: project.scan.period_ms,
      program: program?.name ?? fbd.name,
    },
    variables,
    io_image,
    network: { blocks: fbd.blocks, wires: fbd.wires },
    instances,
    schedule,
  };

  return { ok: true, ir, diagnostics };
}
