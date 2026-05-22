import { IR_VERSION } from "./constants";
import type {
  CompileDiagnostic,
  CompileResult,
  FbdBlock,
  FbdSource,
  FbdWire,
  IoMap,
  IrVariable,
  NanoPlcProject,
  PlcIr,
  ScheduleStep,
} from "./types";
import { validateFbdSource } from "./validate";

const BLOCK_OUTPUT_PORT = "Q";
const SUPPORTED_BLOCKS = new Set(["DI", "DO", "AND", "OR", "NOT", "TON"]);

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

function inputPortsForType(type: string): Set<string> {
  switch (type.toUpperCase()) {
    case "DI":
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
      const symbol = String(block.params?.symbol ?? block.id);
      const mapped = ioBySymbol.get(symbol);
      if (t === "DI") {
        const index = mapped?.index ?? diAuto++;
        di.push({ symbol, index });
        variables.push({ name: symbol, type: "BOOL", role: "di" });
      } else {
        const index = mapped?.index ?? doAuto++;
        doList.push({ symbol, index });
        variables.push({ name: symbol, type: "BOOL", role: "do" });
      }
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
      const symbol = String(block.params?.symbol ?? block.id);
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
      const symbol = String(block.params?.symbol ?? block.id);
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
    return String(block.params?.symbol ?? block.id);
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
