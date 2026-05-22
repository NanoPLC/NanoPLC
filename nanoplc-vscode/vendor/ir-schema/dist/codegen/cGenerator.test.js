"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const strict_1 = __importDefault(require("node:assert/strict"));
const node_crypto_1 = require("node:crypto");
const node_test_1 = require("node:test");
const compileFbd_1 = require("../compileFbd");
const constants_1 = require("../constants");
const cGenerator_1 = require("./cGenerator");
const project = {
    schema_version: constants_1.PROJECT_SCHEMA_VERSION,
    name: "and_gate",
    device: { board: "esp32-s3", idf_target: "esp32s3" },
    scan: { period_ms: 10 },
    programs: [{ id: "main", name: "Main", source: "src/main.fbd.json", language: "fbd" }],
};
const fbd = {
    schema_version: constants_1.FBD_SOURCE_SCHEMA_VERSION,
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
(0, node_test_1.test)("codegenC emits scan function for and_gate", () => {
    const compiled = (0, compileFbd_1.compileFbdToIr)(project, fbd, "main");
    strict_1.default.ok(compiled.ir);
    const irJson = JSON.stringify(compiled.ir);
    const hash = (0, node_crypto_1.createHash)("sha256").update(irJson).digest("hex");
    const out = (0, cGenerator_1.codegenC)(compiled.ir, hash);
    strict_1.default.match(out.plc_program_c, /nanoplc_generated_program_scan/);
    strict_1.default.match(out.plc_program_c, /nanoplc_hal_read_di/);
    strict_1.default.match(out.plc_program_c, /nanoplc_hal_write_do/);
    strict_1.default.match(out.plc_program_c, /&&/);
    strict_1.default.match(out.plc_program_c, /npgen_do\[0\]/);
});
