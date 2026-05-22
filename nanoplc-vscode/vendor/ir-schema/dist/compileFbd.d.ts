import type { CompileResult, IoMap, NanoPlcProject } from "./types";
export declare function compileFbdToIr(project: NanoPlcProject, fbdRaw: unknown, programId: string, ioMap?: IoMap): CompileResult;
