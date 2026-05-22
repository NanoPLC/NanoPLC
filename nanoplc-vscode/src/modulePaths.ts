import * as fs from "fs";
import * as path from "path";

/**
 * VSIX ships @nanoplc/ir-schema under packaged-deps/ (see scripts/sync-ir-schema.js).
 * Plain Node globalPaths is not enough in the VS Code / Electron extension host.
 */
const nodeModule = require("module") as typeof import("module") & {
  globalPaths: string[];
  _nodeModulePaths: (from: string) => string[];
  _resolveFilename: (
    request: string,
    parent: { filename?: string; paths?: string[] } | null | undefined,
    isMain: boolean,
    options?: unknown
  ) => string;
};

const extensionRoot = path.join(__dirname, "..");
const packagedDepsRoot = path.join(extensionRoot, "packaged-deps");
const packagedNodeModules = path.join(packagedDepsRoot, "node_modules");
const irSchemaRoot = path.join(packagedNodeModules, "@nanoplc", "ir-schema");
const irSchemaEntry = path.join(irSchemaRoot, "dist", "index.js");

function isInsideExtension(filePath: string): boolean {
  const ext = extensionRoot.replace(/\\/g, "/").toLowerCase();
  const file = filePath.replace(/\\/g, "/").toLowerCase();
  return file.startsWith(ext);
}

function installPackagedModuleResolution(): void {
  if (!fs.existsSync(irSchemaEntry)) {
    return;
  }

  nodeModule.globalPaths.unshift(packagedDepsRoot);

  const origNodeModulePaths = nodeModule._nodeModulePaths.bind(nodeModule);
  nodeModule._nodeModulePaths = (from: string) => {
    const paths = origNodeModulePaths(from);
    if (isInsideExtension(from)) {
      return [packagedNodeModules, ...paths];
    }
    return paths;
  };

  const origResolveFilename = nodeModule._resolveFilename.bind(nodeModule);
  nodeModule._resolveFilename = (request, parent, isMain, options) => {
    if (request === "@nanoplc/ir-schema" && fs.existsSync(irSchemaEntry)) {
      return irSchemaEntry;
    }
    return origResolveFilename(request, parent, isMain, options);
  };
}

installPackagedModuleResolution();
