"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PlcSimulator = void 0;
const executeScan_1 = require("./executeScan");
class PlcSimulator {
    constructor(ir) {
        this.ir = ir;
        this.state = (0, executeScan_1.createSimState)(ir);
    }
    get scanPeriodMs() {
        return this.ir.project.scan_period_ms > 0 ? this.ir.project.scan_period_ms : 10;
    }
    get running() {
        return this.timer !== undefined;
    }
    reset() {
        this.state = (0, executeScan_1.createSimState)(this.ir);
        this.listener?.((0, executeScan_1.snapshot)(this.state));
    }
    setDi(index, value) {
        if (index >= 0 && index < this.state.di.length) {
            this.state.di[index] = value;
        }
    }
    setDiBySymbol(symbol, value) {
        const entry = this.ir.io_image.di.find((d) => d.symbol === symbol);
        if (entry) {
            this.setDi(entry.index, value);
        }
    }
    /** Run exactly one scan (useful in tests). */
    stepOnce() {
        return (0, executeScan_1.runScan)(this.state, this.ir, this.scanPeriodMs);
    }
    start(onTick) {
        if (this.timer) {
            return;
        }
        this.listener = onTick;
        onTick((0, executeScan_1.snapshot)(this.state));
        this.timer = setInterval(() => {
            const snap = (0, executeScan_1.runScan)(this.state, this.ir, this.scanPeriodMs);
            onTick(snap);
        }, this.scanPeriodMs);
    }
    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
        this.listener = undefined;
    }
    currentSnapshot() {
        return (0, executeScan_1.snapshot)(this.state);
    }
}
exports.PlcSimulator = PlcSimulator;
