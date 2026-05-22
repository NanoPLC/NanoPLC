"use strict";

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const extRoot = path.join(__dirname, "..");
const srcRoot = path.join(extRoot, "..", "packages", "ir-schema");
const destRoots = [path.join(extRoot, "packaged-deps", "node_modules", "@nanoplc", "ir-schema")];

function buildIrSchema() {
  const tscJs = path.join(srcRoot, "node_modules", "typescript", "lib", "tsc.js");
  if (!fs.existsSync(tscJs)) {
    throw new Error(
      `typescript not found at ${tscJs}. Run npm install in packages/ir-schema first.`,
    );
  }
  console.log("Building @nanoplc/ir-schema...");
  execSync(`node "${tscJs}" -p .`, { cwd: srcRoot, stdio: "inherit" });
}

function copyIrSchemaTo(destRoot, distRoot, schemasDir) {
  fs.mkdirSync(destRoot, { recursive: true });
  fs.rmSync(path.join(destRoot, "dist"), { recursive: true, force: true });
  fs.cpSync(distRoot, path.join(destRoot, "dist"), { recursive: true });
  fs.copyFileSync(path.join(srcRoot, "package.json"), path.join(destRoot, "package.json"));

  const destSchemas = path.join(destRoot, "schemas");
  fs.rmSync(destSchemas, { recursive: true, force: true });
  if (fs.existsSync(schemasDir)) {
    fs.cpSync(schemasDir, destSchemas, { recursive: true });
  }
}

function syncIrSchema() {
  buildIrSchema();

  const distRoot = path.join(srcRoot, "dist");
  const schemasDir = path.join(srcRoot, "schemas");
  const distIndex = path.join(distRoot, "index.js");
  if (!fs.existsSync(distIndex)) {
    console.error("Missing compiled @nanoplc/ir-schema at", distIndex);
    process.exit(1);
  }

  for (const destRoot of destRoots) {
    copyIrSchemaTo(destRoot, distRoot, schemasDir);
  }

  console.log("Synced @nanoplc/ir-schema into packaged-deps/node_modules.");
}

syncIrSchema();
