import assert from "node:assert/strict";
import { test } from "node:test";

import { FBD_SOURCE_SCHEMA_VERSION } from "./constants";
import { inferFbdPortTypes } from "./fbdPortTypes";
import type { FbdSource } from "./types";

test("inferFbdPortTypes DI and AND outputs are BOOL", () => {
  const fbd: FbdSource = {
    schema_version: FBD_SOURCE_SCHEMA_VERSION,
    name: "Main",
    blocks: [
      { id: "di1", type: "DI", params: { channel: 1 } },
      { id: "and1", type: "AND" },
    ],
    wires: [{ from: { block: "di1", port: "Q" }, to: { block: "and1", port: "IN1" } }],
  };
  const types = inferFbdPortTypes(fbd);
  assert.equal(types.outputs.di1, "BOOL");
  assert.equal(types.outputs.and1, "BOOL");
  assert.equal(types.inputs.and1?.IN1, "BOOL");
  assert.equal(types.inputs.and1?.IN2, "BOOL");
});

test("inferFbdPortTypes AI output is REAL", () => {
  const fbd: FbdSource = {
    schema_version: FBD_SOURCE_SCHEMA_VERSION,
    name: "Main",
    blocks: [{ id: "ai1", type: "AI", params: { channel: 1 } }],
    wires: [],
  };
  const types = inferFbdPortTypes(fbd);
  assert.equal(types.outputs.ai1, "REAL");
});

test("inferFbdPortTypes ADD unifies wired input types", () => {
  const fbd: FbdSource = {
    schema_version: FBD_SOURCE_SCHEMA_VERSION,
    name: "Main",
    blocks: [
      { id: "c1", type: "CONST", params: { data_type: "INT", value: 1 } },
      { id: "c2", type: "CONST", params: { data_type: "DINT", value: 2 } },
      { id: "add1", type: "ADD" },
    ],
    wires: [
      { from: { block: "c1", port: "Q" }, to: { block: "add1", port: "IN1" } },
      { from: { block: "c2", port: "Q" }, to: { block: "add1", port: "IN2" } },
    ],
  };
  const types = inferFbdPortTypes(fbd);
  assert.equal(types.outputs.add1, "DINT");
});

test("inferFbdPortTypes CONST respects data_type param", () => {
  const fbd: FbdSource = {
    schema_version: FBD_SOURCE_SCHEMA_VERSION,
    name: "Main",
    blocks: [{ id: "c1", type: "CONST", params: { data_type: "REAL", value: 3.14 } }],
    wires: [],
  };
  const types = inferFbdPortTypes(fbd);
  assert.equal(types.outputs.c1, "REAL");
});
