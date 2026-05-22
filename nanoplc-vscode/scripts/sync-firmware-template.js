/**
 * Copy repo firmware/ into nanoplc-vscode/firmware-template for VSIX packaging.
 * Replaces generated C sources with compile stubs.
 */
const fs = require("fs");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..", "..");
const srcFirmware = path.join(repoRoot, "firmware");
const destTemplate = path.join(__dirname, "..", "firmware-template");

const SKIP_NAMES = new Set(["build", "sdkconfig", "sdkconfig.old", ".git"]);

const PLC_STUB = `/* Stub until first NanoPLC compile/codegen — do not edit. */
#include "nanoplc_generated.h"

uint32_t nanoplc_runtime_scan_period_ms(void);

void nanoplc_generated_program_scan(void)
{
}

uint32_t nanoplc_generated_magic(void)
{
    return NANOPLC_GENERATED_MAGIC_STUB;
}
`;

const HAL_STUB = `/* Stub until first NanoPLC compile/codegen — do not edit. */
#include "nanoplc_generated.h"
#include "nanoplc_hal.h"

void nanoplc_generated_io_bind(void)
{
    nanoplc_hal_init(NULL, 0, NULL, 0);
}
`;

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    if (SKIP_NAMES.has(ent.name)) {
      continue;
    }
    const from = path.join(src, ent.name);
    const to = path.join(dest, ent.name);
    if (ent.isDirectory()) {
      copyDir(from, to);
    } else {
      fs.copyFileSync(from, to);
    }
  }
}

function main() {
  if (!fs.existsSync(path.join(srcFirmware, "CMakeLists.txt"))) {
    console.error(`Firmware source not found: ${srcFirmware}`);
    process.exit(1);
  }

  fs.rmSync(destTemplate, { recursive: true, force: true });
  copyDir(srcFirmware, destTemplate);

  const genDir = path.join(destTemplate, "components", "nanoplc_generated");
  fs.writeFileSync(path.join(genDir, "plc_program.c"), PLC_STUB, "utf8");
  fs.writeFileSync(path.join(genDir, "io_hal_config.c"), HAL_STUB, "utf8");

  console.log(`Synced firmware template → ${destTemplate}`);
}

main();
