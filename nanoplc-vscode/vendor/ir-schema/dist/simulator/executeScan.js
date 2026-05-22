"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.executeScheduleStep = executeScheduleStep;
exports.createSimState = createSimState;
exports.runScan = runScan;
exports.snapshot = snapshot;
function readBool(state, name) {
    if (!name) {
        return false;
    }
    const v = state.vars[name];
    return v === true || v === 1;
}
function writeBool(state, name, value) {
    if (!name) {
        return;
    }
    state.vars[name] = value;
}
function tonState(state, blockId) {
    let t = state.ton.get(blockId);
    if (!t) {
        t = { et_ms: 0, q: false };
        state.ton.set(blockId, t);
    }
    return t;
}
function executeTon(state, step, dt_ms) {
    const blockId = step.block_id ?? "ton";
    const t = tonState(state, blockId);
    const pt = step.pt_ms ?? 1000;
    const inn = readBool(state, step.in1);
    if (!inn) {
        t.et_ms = 0;
        t.q = false;
    }
    else {
        t.et_ms += dt_ms;
        t.q = t.et_ms >= pt;
    }
    writeBool(state, step.out, t.q);
    state.vars[`${blockId}.ET`] = t.et_ms;
    state.vars[`${blockId}.Q`] = t.q;
}
function executeScheduleStep(state, step, dt_ms) {
    switch (step.op) {
        case "read_di": {
            const idx = step.index ?? 0;
            writeBool(state, step.out ?? step.symbol, state.di[idx] ?? false);
            break;
        }
        case "write_do": {
            const value = readBool(state, step.in1);
            const idx = step.index ?? 0;
            state.do[idx] = value;
            if (step.symbol) {
                writeBool(state, step.symbol, value);
            }
            break;
        }
        case "and":
            writeBool(state, step.out, readBool(state, step.in1) && readBool(state, step.in2));
            break;
        case "or":
            writeBool(state, step.out, readBool(state, step.in1) || readBool(state, step.in2));
            break;
        case "not":
            writeBool(state, step.out, !readBool(state, step.in1));
            break;
        case "ton":
            executeTon(state, step, dt_ms);
            break;
        case "move":
            if (step.out && step.in1) {
                state.vars[step.out] = state.vars[step.in1] ?? false;
            }
            break;
        default:
            break;
    }
}
function createSimState(ir) {
    const diLen = Math.max(0, ...ir.io_image.di.map((d) => d.index + 1), 0);
    const doLen = Math.max(0, ...ir.io_image.do.map((d) => d.index + 1), 0);
    const vars = {};
    for (const v of ir.variables) {
        if (v.type === "BOOL") {
            vars[v.name] = false;
        }
        else {
            vars[v.name] = 0;
        }
    }
    return {
        vars,
        di: Array.from({ length: diLen }, () => false),
        do: Array.from({ length: doLen }, () => false),
        ton: new Map(),
        scan_index: 0,
        elapsed_ms: 0,
    };
}
function runScan(state, ir, dt_ms) {
    for (const step of ir.schedule) {
        executeScheduleStep(state, step, dt_ms);
    }
    state.scan_index += 1;
    state.elapsed_ms += dt_ms;
    return snapshot(state);
}
function snapshot(state) {
    return {
        scan_index: state.scan_index,
        elapsed_ms: state.elapsed_ms,
        vars: { ...state.vars },
        di: [...state.di],
        do: [...state.do],
    };
}
