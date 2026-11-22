import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";

import {
  compileGoldenScenario,
  findHostCCompiler,
  goldenMismatches,
  loadGoldenScenarios,
  runGoldenC,
  runGoldenSimulator,
} from "./golden";

const packageRoot = join(__dirname, "..", "..");
const repoRoot = join(packageRoot, "..", "..");
const examplesDir = join(repoRoot, "examples");
const firmwareDir = join(repoRoot, "firmware");
const scenarios = loadGoldenScenarios(join(packageRoot, "golden"));
const compiler = findHostCCompiler();
const requireC = process.env.NANOPLC_REQUIRE_CC === "1";

function describe(mismatches: ReturnType<typeof goldenMismatches>): string {
  return mismatches
    .map((m) => `step ${m.step} ${m.key}: expected ${m.expected}, got ${m.actual}`)
    .join("\n");
}

test("golden scenarios are present", () => {
  assert.ok(scenarios.length > 0);
});

test("a host C compiler is available when NANOPLC_REQUIRE_CC=1", () => {
  assert.ok(!requireC || compiler, "No host C compiler found (set NANOPLC_CC or CC).");
});

for (const scenario of scenarios) {
  test(`golden ${scenario.name}: simulator`, () => {
    const ir = compileGoldenScenario(scenario, examplesDir);
    const mismatches = goldenMismatches(scenario, runGoldenSimulator(ir, scenario));
    assert.equal(mismatches.length, 0, describe(mismatches));
  });

  test(`golden ${scenario.name}: generated C on host`, { skip: compiler ? false : "no host C compiler" }, () => {
    const ir = compileGoldenScenario(scenario, examplesDir);
    const mismatches = goldenMismatches(scenario, runGoldenC(ir, scenario, compiler!, firmwareDir));
    assert.equal(mismatches.length, 0, describe(mismatches));
  });
}
