import type { FbdBlock, FbdSource } from "@nanoplc/ir-schema";

const BLOCK_W = 128;
const BLOCK_H = 56;
const COL_GAP = 180;
const ROW_GAP = 80;
const ORIGIN_X = 48;
const ORIGIN_Y = 48;

function columnForType(type: string): number {
  switch (type.toUpperCase()) {
    case "DI":
      return 0;
    case "DO":
      return 3;
    case "AND":
    case "OR":
    case "NOT":
      return 2;
    case "TON":
      return 1;
    default:
      return 2;
  }
}

/** Assign canvas positions when `layout` is missing (editor-only; not persisted until user moves a block). */
export function ensureLayout(fbd: FbdSource): Record<string, { x: number; y: number }> {
  const layout = { ...(fbd.layout ?? {}) };
  const byCol = new Map<number, number>();

  for (const block of fbd.blocks) {
    if (layout[block.id]) {
      continue;
    }
    const col = columnForType(block.type);
    const row = byCol.get(col) ?? 0;
    byCol.set(col, row + 1);
    layout[block.id] = {
      x: ORIGIN_X + col * COL_GAP,
      y: ORIGIN_Y + row * ROW_GAP,
    };
  }

  return layout;
}

export function nextBlockId(blocks: FbdBlock[], type: string): string {
  const base = type.toLowerCase().replace(/[^a-z0-9]/g, "_");
  let n = 1;
  const ids = new Set(blocks.map((b) => b.id));
  while (ids.has(`${base}${n}`)) {
    n++;
  }
  return `${base}${n}`;
}

export { BLOCK_W, BLOCK_H };
