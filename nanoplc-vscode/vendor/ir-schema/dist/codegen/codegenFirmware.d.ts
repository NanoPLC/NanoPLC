import type { IoMap, PlcIr } from "../types";
export declare function codegenIoHalConfig(ir: PlcIr, ioMap?: IoMap): string;
export interface CodegenFirmwareOutput {
    plc_program_c: string;
    io_hal_config_c: string;
    magic: number;
    ir_sha256_prefix: string;
}
