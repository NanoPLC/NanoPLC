import type { PlcIr, ScheduleStep } from "../types";
import type { SimState, SimulatorSnapshot } from "./types";
export declare function executeScheduleStep(state: SimState, step: ScheduleStep, dt_ms: number): void;
export declare function createSimState(ir: PlcIr): SimState;
export declare function runScan(state: SimState, ir: PlcIr, dt_ms: number): SimulatorSnapshot;
export declare function snapshot(state: SimState): SimulatorSnapshot;
