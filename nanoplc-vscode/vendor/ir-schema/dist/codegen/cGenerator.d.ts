import type { PlcIr } from "../types";
import type { IoMap } from "../types";
import { type CodegenFirmwareOutput } from "./codegenFirmware";
export interface CodegenCResult {
    plc_program_c: string;
    magic: number;
    ir_sha256_prefix: string;
}
export declare function computeIrMagic(ir: PlcIr, irSha256Hex: string): number;
export declare function codegenC(ir: PlcIr, irSha256Hex: string, _ioMap?: IoMap): CodegenCResult;
export declare function codegenFirmware(ir: PlcIr, irSha256Hex: string, ioMap?: IoMap): CodegenFirmwareOutput;
