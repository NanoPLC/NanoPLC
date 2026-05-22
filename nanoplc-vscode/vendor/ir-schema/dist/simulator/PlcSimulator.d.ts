import type { PlcIr } from "../types";
import type { SimulatorSnapshot } from "./types";
export declare class PlcSimulator {
    private readonly ir;
    private state;
    private timer;
    private listener;
    constructor(ir: PlcIr);
    get scanPeriodMs(): number;
    get running(): boolean;
    reset(): void;
    setDi(index: number, value: boolean): void;
    setDiBySymbol(symbol: string, value: boolean): void;
    /** Run exactly one scan (useful in tests). */
    stepOnce(): SimulatorSnapshot;
    start(onTick: (snap: SimulatorSnapshot) => void): void;
    stop(): void;
    currentSnapshot(): SimulatorSnapshot;
}
