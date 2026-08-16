import assert from "node:assert/strict";
import { test } from "node:test";

import { nextPouVarName, parsePouVariables } from "./pouVars";

test("parsePouVariables accepts IN OUT VAR TEMP", () => {
  const { variables, diagnostics } = parsePouVariables([
    { name: "Enable", class: "IN", type: "BOOL" },
    { name: "Count", class: "VAR", type: "INT", initial: 3 },
    { name: "Tmp", class: "TEMP", type: "REAL" },
  ]);
  assert.equal(diagnostics.length, 0);
  assert.equal(variables.length, 3);
  assert.equal(variables[1]?.initial, 3);
});

test("parsePouVariables rejects duplicates and bad names", () => {
  const dup = parsePouVariables([
    { name: "Enable", class: "IN", type: "BOOL" },
    { name: "enable", class: "OUT", type: "BOOL" },
  ]);
  assert.ok(dup.diagnostics.some((d) => d.code === "NP-0217"));

  const bad = parsePouVariables([{ name: "1x", class: "IN", type: "BOOL" }]);
  assert.ok(bad.diagnostics.some((d) => d.code === "NP-0216"));
});

test("nextPouVarName increments per class", () => {
  assert.equal(nextPouVarName("IN", []), "In1");
  assert.equal(nextPouVarName("IN", [{ name: "In1", class: "IN", type: "BOOL" }]), "In2");
  assert.equal(nextPouVarName("IN_OUT", []), "InOut1");
});
