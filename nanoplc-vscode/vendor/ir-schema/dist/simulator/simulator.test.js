"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const strict_1 = __importDefault(require("node:assert/strict"));
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const node_test_1 = require("node:test");
const compileFbd_1 = require("../compileFbd");
const constants_1 = require("../constants");
const PlcSimulator_1 = require("./PlcSimulator");
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
const baseProject = {
    schema_version: constants_1.PROJECT_SCHEMA_VERSION,
    name: "and_gate",
    device: { board: "esp32-s3", idf_target: "esp32s3" },
    scan: { period_ms: 10 },
    programs: [{ id: "main", name: "Main", source: "src/main.fbd.json", language: "fbd" }],
};
(0, node_test_1.test)("simulator and_gate: both inputs true → DO on", () => {
    const compiled = (0, compileFbd_1.compileFbdToIr)(baseProject, andFbd, "main");
    strict_1.default.ok(compiled.ir);
    const sim = new PlcSimulator_1.PlcSimulator(compiled.ir);
    sim.setDi(0, true);
    sim.setDi(1, true);
    const snap = sim.stepOnce();
    strict_1.default.equal(snap.do[0], true);
    strict_1.default.equal(snap.vars["DO_Lamp"], true);
});
(0, node_test_1.test)("simulator and_gate: one input false → DO off", () => {
    const compiled = (0, compileFbd_1.compileFbdToIr)(baseProject, andFbd, "main");
    strict_1.default.ok(compiled.ir);
    const sim = new PlcSimulator_1.PlcSimulator(compiled.ir);
    sim.setDi(0, true);
    sim.setDi(1, false);
    const snap = sim.stepOnce();
    strict_1.default.equal(snap.do[0], false);
});
(0, node_test_1.test)("examples/and_gate IR file compiles and simulates", () => {
    const root = (0, node_path_1.join)(__dirname, "..", "..", "..", "..", "examples", "and_gate");
    const project = JSON.parse((0, node_fs_1.readFileSync)((0, node_path_1.join)(root, "nanoplc.project.json"), "utf8"));
    const fbd = JSON.parse((0, node_fs_1.readFileSync)((0, node_path_1.join)(root, "src", "main.fbd.json"), "utf8"));
    const compiled = (0, compileFbd_1.compileFbdToIr)(project, fbd, "main");
    strict_1.default.ok(compiled.ok && compiled.ir);
    const sim = new PlcSimulator_1.PlcSimulator(compiled.ir);
    sim.setDiBySymbol("DI_Start", true);
    sim.setDiBySymbol("DI_Enable", true);
    strict_1.default.equal(sim.stepOnce().vars["DO_Lamp"], true);
});
