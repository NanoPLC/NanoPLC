"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateProject = validateProject;
exports.validateFbdSource = validateFbdSource;
const constants_1 = require("./constants");
function diag(code, message, severity = "error", block_id) {
    return { code, message, severity, block_id };
}
function validateProject(raw) {
    const diagnostics = [];
    if (raw == null || typeof raw !== "object") {
        return { diagnostics: [diag("NP-0100", "Project file must be a JSON object.")] };
    }
    const o = raw;
    if (o.schema_version !== constants_1.PROJECT_SCHEMA_VERSION) {
        diagnostics.push(diag("NP-0101", `Unsupported project schema_version (expected ${constants_1.PROJECT_SCHEMA_VERSION}).`));
    }
    if (typeof o.name !== "string" || o.name.trim() === "") {
        diagnostics.push(diag("NP-0102", "Project name is required."));
    }
    if (!o.device || typeof o.device !== "object") {
        diagnostics.push(diag("NP-0103", "Project device section is required."));
    }
    if (!o.scan || typeof o.scan !== "object") {
        diagnostics.push(diag("NP-0104", "Project scan section is required."));
    }
    if (!Array.isArray(o.programs) || o.programs.length === 0) {
        diagnostics.push(diag("NP-0105", "At least one program entry is required."));
    }
    if (diagnostics.some((d) => d.severity === "error")) {
        return { diagnostics };
    }
    return { project: raw, diagnostics };
}
function validateFbdSource(raw) {
    const diagnostics = [];
    if (raw == null || typeof raw !== "object") {
        return { diagnostics: [diag("NP-0200", "FBD source must be a JSON object.")] };
    }
    const o = raw;
    if (o.schema_version !== constants_1.FBD_SOURCE_SCHEMA_VERSION) {
        diagnostics.push(diag("NP-0201", `Unsupported FBD schema_version (expected ${constants_1.FBD_SOURCE_SCHEMA_VERSION}).`));
    }
    if (typeof o.name !== "string") {
        diagnostics.push(diag("NP-0202", "FBD network name is required."));
    }
    if (!Array.isArray(o.blocks)) {
        diagnostics.push(diag("NP-0203", "FBD blocks array is required."));
    }
    if (!Array.isArray(o.wires)) {
        diagnostics.push(diag("NP-0204", "FBD wires array is required."));
    }
    if (diagnostics.some((d) => d.severity === "error")) {
        return { diagnostics };
    }
    return { fbd: raw, diagnostics };
}
