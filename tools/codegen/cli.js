#!/usr/bin/env node
/**
 * CLI: IR JSON or a NanoPLC project → firmware/components/nanoplc_generated/{plc_program.c,io_hal_config.c}
 *
 * Usage:
 *   nanoplc-codegen <ir.json> [output-dir]
 *   nanoplc-codegen --project <project-dir> [output-dir]
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { buildCodegenIoContext, codegenFirmware, compileProjectDir } = require("@nanoplc/ir-schema");

const USAGE = "Usage: nanoplc-codegen <ir.json> [output-dir]\n       nanoplc-codegen --project <project-dir> [output-dir]";
const args = process.argv.slice(2);
const projectMode = args[0] === "--project";
const input = projectMode ? args[1] : args[0];
const outDir =
  (projectMode ? args[2] : args[1]) ||
  path.join(process.cwd(), "firmware", "components", "nanoplc_generated");

if (!input) {
  console.error(USAGE);
  process.exit(1);
}

let ir;
let irText;
let context;
if (projectMode) {
  const result = compileProjectDir(input);
  for (const d of result.diagnostics) {
    console.error(`${d.severity} ${d.code}${d.program_id ? ` [${d.program_id}]` : ""}${d.block_id ? ` (${d.block_id})` : ""}: ${d.message}`);
  }
  if (!result.ok || !result.ir) {
    console.error(`Compile failed for ${input}.`);
    process.exit(2);
  }
  ir = result.ir;
  irText = JSON.stringify(ir, null, 2);
  context = buildCodegenIoContext(input, result.project);
} else {
  irText = fs.readFileSync(input, "utf8");
  ir = JSON.parse(irText);
}

const hash = crypto.createHash("sha256").update(irText).digest("hex");
const result = codegenFirmware(ir, hash, context);

fs.mkdirSync(outDir, { recursive: true });
const plcPath = path.join(outDir, "plc_program.c");
fs.writeFileSync(plcPath, result.plc_program_c, "utf8");
fs.writeFileSync(path.join(outDir, "io_hal_config.c"), result.io_hal_config_c, "utf8");
console.log(`Wrote ${plcPath} + io_hal_config.c (magic 0x${result.magic.toString(16)})`);
