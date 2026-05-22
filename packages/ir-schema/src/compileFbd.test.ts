import assert from "node:assert/strict";
import { test } from "node:test";

import { compileFbdToIr } from "./compileFbd";
import { FBD_SOURCE_SCHEMA_VERSION, PROJECT_SCHEMA_VERSION } from "./constants";
import type { FbdSource, NanoPlcProject } from "./types";

const baseProject: NanoPlcProject = {
  schema_version: PROJECT_SCHEMA_VERSION,
  name: "and_gate",
  device: { board: "esp32-s3", idf_target: "esp32s3" },
  scan: { period_ms: 10 },
  programs: [{ id: "main", name: "Main", source: "src/main.fbd.json", language: "fbd" }],
};

const andFbd: FbdSource = {
  schema_version: FBD_SOURCE_SCHEMA_VERSION,
  name: "Main",
  blocks: [
    { id: "di_start", type: "DI", params: { symbol: "DI_Start" } },
    { id: "di_en", type: "DI", params: { symbol: "DI_Enable" } },
    { id: "and1", type: "AND" },
    { id: "do_lamp", type: "DO", params: { symbol: "DO_Lamp" } },
  ],
  wires: [
    { from: { block: "di_start", port: "Q" }, to: { block: "and1", port: "IN1" } },
    { from: { block: "di_en", port: "Q" }, to: { block: "and1", port: "IN2" } },
    { from: { block: "and1", port: "Q" }, to: { block: "do_lamp", port: "IN" } },
  ],
};

test("compileFbdToIr and_gate produces schedule", () => {
  const result = compileFbdToIr(baseProject, andFbd, "main");
  assert.equal(result.ok, true);
  assert.ok(result.ir);
  const ir = result.ir;
  assert.equal(ir.schedule.length, 4);
  assert.equal(ir.schedule[2]?.op, "and");
  assert.deepEqual(
    ir.io_image.di.map((d) => d.symbol),
    ["DI_Start", "DI_Enable"]
  );
});

test("compileFbdToIr detects cycle", () => {
  const cyclic: FbdSource = {
    ...andFbd,
    blocks: [
      { id: "a", type: "AND" },
      { id: "b", type: "AND" },
    ],
    wires: [
      { from: { block: "a", port: "Q" }, to: { block: "b", port: "IN1" } },
      { from: { block: "b", port: "Q" }, to: { block: "a", port: "IN1" } },
    ],
  };
  const result = compileFbdToIr(baseProject, cyclic, "main");
  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some((d) => d.code === "NP-0400"));
});
