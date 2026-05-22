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
