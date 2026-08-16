import { callPortIrName, pouIrName } from "./pouVars";
import type { FbdBlock } from "./types";

function parseChannel(params: FbdBlock["params"]): number | undefined {
  if (params?.channel === undefined || params.channel === null) {
    return undefined;
  }
  const n = typeof params.channel === "number" ? params.channel : Number(params.channel);
  return Number.isFinite(n) && n >= 1 ? Math.trunc(n) : undefined;
}

/** Symbol stored on DI/DO/AI blocks and in `io_image` / simulator vars. */
export function resolveIoSymbol(block: FbdBlock, kind: "DI" | "DO" | "AI"): string {
  if (block.params?.symbol !== undefined && String(block.params.symbol).trim() !== "") {
    return String(block.params.symbol);
  }
  const channel = parseChannel(block.params);
  if (channel !== undefined) {
    return `${kind}_${channel}`;
  }
  return block.id;
}

/** Combinational / FB output wire name (`__<blockId>_Q`). */
export function fbdOutputVar(blockId: string): string {
  return `__${blockId}_Q`;
}

/**
 * IR variable name for a block output port — same mapping the compiler uses for wires.
 * Used by the FBD editor for live flow highlighting.
 */
export function fbdSourcePortIrName(block: FbdBlock, port: string, programId: string): string {
  const t = block.type.toUpperCase();
  if (t === "DI") {
    return resolveIoSymbol(block, "DI");
  }
  if (t === "AI") {
    return resolveIoSymbol(block, "AI");
  }
  if (t === "DO") {
    return resolveIoSymbol(block, "DO");
  }
  if (t === "LOCAL") {
    return pouIrName(programId, String(block.params?.name ?? "").trim());
  }
  if (t === "CALL") {
    return callPortIrName(block.id, port);
  }
  return fbdOutputVar(block.id);
}
