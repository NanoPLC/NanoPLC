import assert from "node:assert/strict";
import { test } from "node:test";

import { fbdOutputVar, fbdSourcePortIrName, resolveIoSymbol } from "./fbdIrNames";
import type { FbdBlock } from "./types";

test("fbdSourcePortIrName maps DI/LOCAL/CALL/AND like the compiler", () => {
  const di: FbdBlock = { id: "di1", type: "DI", params: { channel: 2, symbol: "DI_Enable" } };
  const loc: FbdBlock = { id: "loc1", type: "LOCAL", params: { name: "Flag" } };
  const call: FbdBlock = { id: "c1", type: "CALL", params: { program: "aux" } };
  const and: FbdBlock = { id: "and1", type: "AND" };

  assert.equal(resolveIoSymbol(di, "DI"), "DI_Enable");
  assert.equal(fbdSourcePortIrName(di, "Q", "main"), "DI_Enable");
  assert.equal(fbdSourcePortIrName(loc, "Q", "main"), "main__Flag");
  assert.equal(fbdSourcePortIrName(call, "Result", "main"), "__c1_Result");
  assert.equal(fbdSourcePortIrName(and, "Q", "main"), fbdOutputVar("and1"));
  assert.equal(fbdOutputVar("and1"), "__and1_Q");
});
