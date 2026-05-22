import type { CompileDiagnostic, FbdSource, NanoPlcProject } from "./types";
export declare function validateProject(raw: unknown): {
    project?: NanoPlcProject;
    diagnostics: CompileDiagnostic[];
};
export declare function validateFbdSource(raw: unknown): {
    fbd?: FbdSource;
    diagnostics: CompileDiagnostic[];
};
