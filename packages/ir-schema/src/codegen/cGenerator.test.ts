import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { compileFbdToIr } from "../compileFbd";
import { FBD_SOURCE_SCHEMA_VERSION, PROJECT_SCHEMA_VERSION } from "../constants";
import { codegenC } from "./cGenerator";
import type { FbdSource, NanoPlcProject } from "../types";

const project: NanoPlcProject = {
  schema_version: PROJECT_SCHEMA_VERSION,
  name: "and_gate",
  device: { board: "esp32-s3", idf_target: "esp32s3" },
  scan: { period_ms: 10 },
  programs: [{ id: "main", name: "Main", source: "src/main.fbd.json", language: "fbd" }],
};

const fbd: FbdSource = {
  schema_version: FBD_SOURCE_SCHEMA_VERSION,
  name: "Main",
  blocks: [
    { id: "di_start", type: "DI", params: { channel: 1, symbol: "DI_Start" } },
    { id: "di_en", type: "DI", params: { channel: 2, symbol: "DI_Enable" } },
    { id: "and1", type: "AND" },
    { id: "do_lamp", type: "DO", params: { channel: 1, symbol: "DO_Lamp" } },
  ],
  wires: [
    { from: { block: "di_start", port: "Q" }, to: { block: "and1", port: "IN1" } },
    { from: { block: "di_en", port: "Q" }, to: { block: "and1", port: "IN2" } },
    { from: { block: "and1", port: "Q" }, to: { block: "do_lamp", port: "IN" } },
  ],
};

test("codegenC emits scan function for and_gate", () => {
  const compiled = compileFbdToIr(project, fbd, "main");
  assert.ok(compiled.ir);
  const irJson = JSON.stringify(compiled.ir);
  const hash = createHash("sha256").update(irJson).digest("hex");
  const out = codegenC(compiled.ir, hash);
  assert.match(out.plc_program_c, /nanoplc_generated_program_scan/);
  assert.match(out.plc_program_c, /nanoplc_hal_read_di/);
  assert.match(out.plc_program_c, /nanoplc_hal_write_do/);
  assert.match(out.plc_program_c, /&&/);
  assert.match(out.plc_program_c, /npgen_do\[0\]/);
});

test("codegenC emits math and RS for numeric network", () => {
  const fbd: FbdSource = {
    schema_version: FBD_SOURCE_SCHEMA_VERSION,
    name: "Main",
    blocks: [
      { id: "c1", type: "CONST", params: { data_type: "INT", value: 5 } },
      { id: "c2", type: "CONST", params: { data_type: "INT", value: 3 } },
      { id: "add1", type: "ADD" },
      { id: "di_set", type: "DI", params: { channel: 1, symbol: "DI_Set" } },
      { id: "rs1", type: "RS" },
    ],
    wires: [
      { from: { block: "c1", port: "Q" }, to: { block: "add1", port: "IN1" } },
      { from: { block: "c2", port: "Q" }, to: { block: "add1", port: "IN2" } },
      { from: { block: "di_set", port: "Q" }, to: { block: "rs1", port: "SET" } },
    ],
  };
  const compiled = compileFbdToIr(project, fbd, "main");
  assert.ok(compiled.ir);
  const hash = createHash("sha256").update(JSON.stringify(compiled.ir)).digest("hex");
  const out = codegenC(compiled.ir, hash);
  assert.match(out.plc_program_c, /npgen_v___add1_Q = .* \+ .*/);
  assert.match(out.plc_program_c, /npgen_rs_rs1/);
});

test("codegenC emits powf when POW block present", () => {
  const fbd: FbdSource = {
    schema_version: FBD_SOURCE_SCHEMA_VERSION,
    name: "Main",
    blocks: [
      { id: "c1", type: "CONST", params: { data_type: "REAL", value: 2 } },
      { id: "c2", type: "CONST", params: { data_type: "REAL", value: 3 } },
      { id: "p1", type: "POW" },
    ],
    wires: [
      { from: { block: "c1", port: "Q" }, to: { block: "p1", port: "IN1" } },
      { from: { block: "c2", port: "Q" }, to: { block: "p1", port: "IN2" } },
    ],
  };
  const compiled = compileFbdToIr(project, fbd, "main");
  assert.ok(compiled.ir);
  const hash = createHash("sha256").update(JSON.stringify(compiled.ir)).digest("hex");
  const out = codegenC(compiled.ir, hash);
  assert.match(out.plc_program_c, /#include <math.h>/);
  assert.match(out.plc_program_c, /powf/);
});
