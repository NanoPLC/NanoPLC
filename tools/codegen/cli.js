#!/usr/bin/env node
/**
 * CLI: IR JSON → firmware/components/nanoplc_generated/plc_program.c
 * Usage: node cli.js <ir.json> [output-dir]
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { codegenFirmware } = require("@nanoplc/ir-schema");

const irPath = process.argv[2];
const outDir =
  process.argv[3] ||
  path.join(process.cwd(), "firmware", "components", "nanoplc_generated");

if (!irPath) {
  console.error("Usage: nanoplc-codegen <ir.json> [output-directory]");
  process.exit(1);
}

const irText = fs.readFileSync(irPath, "utf8");
const ir = JSON.parse(irText);
const hash = crypto.createHash("sha256").update(irText).digest("hex");
const result = codegenFirmware(ir, hash);

fs.mkdirSync(outDir, { recursive: true });
const plcPath = path.join(outDir, "plc_program.c");
fs.writeFileSync(plcPath, result.plc_program_c, "utf8");
fs.writeFileSync(path.join(outDir, "io_hal_config.c"), result.io_hal_config_c, "utf8");
console.log(`Wrote ${plcPath} + io_hal_config.c (magic 0x${result.magic.toString(16)})`);
