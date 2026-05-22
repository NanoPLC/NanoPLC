"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const strict_1 = __importDefault(require("node:assert/strict"));
const node_test_1 = require("node:test");
const compileFbd_1 = require("./compileFbd");
const constants_1 = require("./constants");
const baseProject = {
    schema_version: constants_1.PROJECT_SCHEMA_VERSION,
    name: "and_gate",
    device: { board: "esp32-s3", idf_target: "esp32s3" },
    scan: { period_ms: 10 },
    programs: [{ id: "main", name: "Main", source: "src/main.fbd.json", language: "fbd" }],
};
const andFbd = {
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
(0, node_test_1.test)("compileFbdToIr and_gate produces schedule", () => {
    const result = (0, compileFbd_1.compileFbdToIr)(baseProject, andFbd, "main");
    strict_1.default.equal(result.ok, true);
    strict_1.default.ok(result.ir);
    const ir = result.ir;
    strict_1.default.equal(ir.schedule.length, 4);
    strict_1.default.equal(ir.schedule[2]?.op, "and");
    strict_1.default.deepEqual(ir.io_image.di.map((d) => d.symbol), ["DI_Start", "DI_Enable"]);
});
(0, node_test_1.test)("compileFbdToIr detects cycle", () => {
    const cyclic = {
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
    const result = (0, compileFbd_1.compileFbdToIr)(baseProject, cyclic, "main");
    strict_1.default.equal(result.ok, false);
    strict_1.default.ok(result.diagnostics.some((d) => d.code === "NP-0400"));
});
