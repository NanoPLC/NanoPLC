import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { findHostCCompiler } from "./golden";

const repoRoot = join(__dirname, "..", "..", "..", "..");
const coreDir = join(repoRoot, "firmware", "components", "nanoplc_core");
const compiler = findHostCCompiler();

const driver = `#include "nanoplc_wrap.h"
#include <stdio.h>
int main(void) {
  printf("%d %d %u\\n", nanoplc_wrap_i16(32768), nanoplc_wrap_i32(2147483648LL), nanoplc_wrap_u16(-1));
  return 0;
}
`;

test("nanoplc_core wrap matches two's-complement widths", { skip: compiler ? false : "no host C compiler" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "nanoplc-core-"));
  writeFileSync(join(dir, "driver.c"), driver);
  const exe = join(dir, process.platform === "win32" ? "wrap.exe" : "wrap");
  const build = spawnSync(
    compiler!,
    [
      "-std=c11",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-I",
      join(coreDir, "include"),
      "-o",
      exe,
      join(dir, "driver.c"),
      join(coreDir, "nanoplc_wrap.c"),
    ],
    { encoding: "utf8" }
  );
  assert.equal(build.status, 0, `${build.stderr}${build.stdout}`);
  const run = spawnSync(exe, [], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.trim(), "-32768 -2147483648 65535");
});
