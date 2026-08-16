/* global acquireVsCodeApi */
(function () {
  const vscode = acquireVsCodeApi();
  const catalog = window.__NANOPLC_BLOCK_CATALOG__ || [];

  const BLOCK_W = 168;
  const BLOCK_H = 56;

  /** @type {{ outputs: Record<string, string>, outputPorts?: Record<string, Record<string, string>>, inputs: Record<string, Record<string, string>> }} */
  let portTypes = { outputs: {}, outputPorts: {}, inputs: {} };

  /** @type {import('@nanoplc/ir-schema').FbdSource & { layout: Record<string, {x:number,y:number}> } | null} */
  let doc = null;
  /** @type {{ di: Array<{channel:number,symbol:string,index:number,moduleId?:string,moduleName?:string}>, do: Array<{channel:number,symbol:string,index:number,moduleId?:string,moduleName?:string}>, ai: Array<{channel:number,symbol:string,index:number,moduleId?:string,moduleName?:string}>, modules: Array<{id:string,name:string,di:any[],do:any[],ai:any[]}>, source: string }} */
  let ioProfile = { di: [], do: [], ai: [], modules: [], source: "none" };
  let selectedBlockId = null;
  let selectedWireIndex = null;
  /** @type {{ block: string, port: string } | null} */
  let wireFrom = null;
  /** @type {{ from: { block: string, port: string, kind: "in"|"out" }, start: {x:number,y:number}, cursor: {x:number,y:number}, moved: boolean } | null} */
  let wireDrag = null;
  let panX = 0;
  let panY = 0;
  let zoom = 1;
  let dirtyFromUser = false;
  /** @type {{ running: boolean, vars: Record<string, boolean|number> }} */
  let simLive = { running: false, vars: {} };

  const el = {
    title: document.getElementById("doc-title"),
    wireHint: document.getElementById("wire-hint"),
    parseError: document.getElementById("parse-error"),
    palette: document.getElementById("palette"),
    viewport: document.getElementById("canvas-viewport"),
    world: document.getElementById("canvas-world"),
    blocks: document.getElementById("blocks"),
    wires: document.getElementById("wires"),
    properties: document.getElementById("properties-body"),
    btnCompile: document.getElementById("btn-compile"),
    btnBuild: document.getElementById("btn-build"),
    simLiveBadge: document.getElementById("sim-live-badge"),
  };

  /** @type {{ currentProgramId?: string, programs: Array<{id:string,name:string,language:string,variables?:Array<{name:string,class:string,type:string}>}> }} */
  let projectPrograms = { currentProgramId: undefined, programs: [] };
  let selectedVarName = null;

  function callablePrograms() {
    return (projectPrograms.programs || []).filter(
      (p) => p.language === "fbd" && p.id !== projectPrograms.currentProgramId
    );
  }

  function findProgram(id) {
    return (projectPrograms.programs || []).find((p) => p.id === id);
  }

  function docVariables() {
    return doc?.variables || [];
  }

  function findPouVariable(vars, name) {
    const key = String(name || "").trim().toUpperCase();
    return (vars || []).find((v) => String(v.name).toUpperCase() === key);
  }

  function callBlockPorts(vars) {
    const list = vars || [];
    return {
      inputs: list.filter((v) => v.class === "IN" || v.class === "IN_OUT").map((v) => v.name),
      outputs: list.filter((v) => v.class === "OUT" || v.class === "IN_OUT").map((v) => v.name),
    };
  }

  function localBlockPorts(variable) {
    if (!variable) {
      return { inputs: [], outputs: [] };
    }
    if (variable.class === "IN") {
      return { inputs: [], outputs: ["Q"] };
    }
    if (variable.class === "OUT") {
      return { inputs: ["IN"], outputs: [] };
    }
    return { inputs: ["IN"], outputs: ["Q"] };
  }

  function findDef(type, block) {
    if (String(type).toUpperCase() === "CALL") {
      const pid = block?.params?.program;
      const prog = pid ? findProgram(pid) : undefined;
      const ports = callBlockPorts(prog?.variables);
      return {
        type: "CALL",
        label: prog?.name || pid || "Program",
        description: "Calls another PROGRAM. IN, IN_OUT, and OUT appear as ports.",
        category: "program",
        inputs: ports.inputs,
        outputs: ports.outputs,
      };
    }
    if (String(type).toUpperCase() === "LOCAL") {
      const v = findPouVariable(docVariables(), block?.params?.name);
      const ports = localBlockPorts(v);
      return {
        type: "LOCAL",
        label: v?.name || block?.params?.name || "Variable",
        description: "Reads or writes a program variable.",
        category: "variable",
        inputs: ports.inputs,
        outputs: ports.outputs,
      };
    }
    return catalog.find((b) => b.type === String(type).toUpperCase());
  }

  // Keep in sync with packages/ir-schema/src/fbdPortTypes.ts
  const MATH_BLOCKS = new Set(["ADD", "SUB", "MUL", "DIV"]);
  const REAL_MATH_BLOCKS = new Set(["POW", "SQRT"]);
  const BIT_BLOCKS = new Set(["SETBIT", "RESETBIT", "SHL", "SHR", "ROL", "ROR"]);
  const BOOL_BLOCKS = new Set(["AND", "OR", "NOT", "TON", "RS"]);
  const NUMERIC_RANK = { BOOL: 0, WORD: 1, UINT: 2, INT: 3, DINT: 4, REAL: 5 };

  function parseConstDataType(params) {
    const raw = String(params?.data_type ?? params?.type ?? "BOOL").toUpperCase();
    const allowed = ["BOOL", "INT", "DINT", "UINT", "WORD", "REAL"];
    return allowed.includes(raw) ? raw : "BOOL";
  }

  function unifyNumericTypes(a, b) {
    return NUMERIC_RANK[a] >= NUMERIC_RANK[b] ? a : b;
  }

  function findWireTo(blockId, port, wires) {
    const p = port.toUpperCase();
    return wires.find((w) => w.to.block === blockId && w.to.port.toUpperCase() === p);
  }

  function inferOutputTypeForBlock(blockId, blocks, wires, memo, visiting) {
    if (memo.has(blockId)) {
      return memo.get(blockId);
    }
    if (visiting.has(blockId)) {
      return "REAL";
    }
    visiting.add(blockId);
    const block = blocks.get(blockId);
    if (!block) {
      visiting.delete(blockId);
      return "BOOL";
    }
    const t = block.type.toUpperCase();
    let result;
    if (t === "CONST") {
      result = parseConstDataType(block.params);
    } else if (t === "AI") {
      result = "REAL";
    } else if (t === "LOCAL") {
      const v = findPouVariable(docVariables(), block.params?.name);
      result = v?.type || "BOOL";
    } else if (REAL_MATH_BLOCKS.has(t)) {
      result = "REAL";
    } else if (MATH_BLOCKS.has(t)) {
      const in1 = inferWiredSourceType(blockId, "IN1", blocks, wires, memo, visiting);
      const in2 = inferWiredSourceType(blockId, "IN2", blocks, wires, memo, visiting);
      result = unifyNumericTypes(in1, in2);
    } else if (BIT_BLOCKS.has(t)) {
      result = inferWiredSourceType(blockId, "IN", blocks, wires, memo, visiting);
      if (result === "BOOL" || result === "REAL") {
        result = "WORD";
      }
    } else {
      result = "BOOL";
    }
    visiting.delete(blockId);
    memo.set(blockId, result);
    return result;
  }

  function inferWiredSourceType(blockId, port, blocks, wires, memo, visiting) {
    const block = blocks.get(blockId);
    const t = block?.type.toUpperCase() ?? "";
    const wire = findWireTo(blockId, port, wires);
    if (!wire) {
      if (MATH_BLOCKS.has(t) || REAL_MATH_BLOCKS.has(t)) {
        return "REAL";
      }
      if (BIT_BLOCKS.has(t)) {
        return "WORD";
      }
      if (port.toUpperCase() === "BIT" || port.toUpperCase() === "N") {
        return "INT";
      }
      return "BOOL";
    }
    return inferSourcePortType(wire.from.block, wire.from.port, blocks, wires, memo, visiting);
  }

  function inferSourcePortType(fromBlockId, fromPort, blocks, wires, memo, visiting) {
    const fromBlock = blocks.get(fromBlockId);
    const ft = fromBlock?.type.toUpperCase() ?? "";
    if (ft === "CALL") {
      const prog = findProgram(fromBlock.params?.program);
      const v = findPouVariable(prog?.variables, fromPort);
      return v?.type || "BOOL";
    }
    if (ft === "LOCAL") {
      const v = findPouVariable(docVariables(), fromBlock.params?.name);
      return v?.type || "BOOL";
    }
    return inferOutputTypeForBlock(fromBlockId, blocks, wires, memo, visiting);
  }

  function buildBlockOutputTypes(blocks, wires) {
    const memo = new Map();
    const visiting = new Set();
    for (const id of blocks.keys()) {
      inferOutputTypeForBlock(id, blocks, wires, memo, visiting);
    }
    return memo;
  }

  function inferInputPortType(block, port, outputTypes) {
    const t = String(block.type).toUpperCase();
    const p = String(port).toUpperCase();
    if (t === "CALL") {
      const prog = findProgram(block.params?.program);
      return findPouVariable(prog?.variables, port)?.type || "BOOL";
    }
    if (t === "LOCAL") {
      return findPouVariable(docVariables(), block.params?.name)?.type || "BOOL";
    }
    if (t === "DO" || BOOL_BLOCKS.has(t)) {
      return "BOOL";
    }
    if (REAL_MATH_BLOCKS.has(t)) {
      return "REAL";
    }
    if (MATH_BLOCKS.has(t) && (p === "IN1" || p === "IN2")) {
      return outputTypes.get(block.id) ?? "REAL";
    }
    if (BIT_BLOCKS.has(t)) {
      if (p === "BIT" || p === "N") {
        return "INT";
      }
      if (p === "IN") {
        return outputTypes.get(block.id) ?? "WORD";
      }
    }
    return "BOOL";
  }

  function inputPortsForType(type) {
    switch (type.toUpperCase()) {
      case "DI":
      case "AI":
      case "CONST":
        return [];
      case "DO":
        return ["IN"];
      case "AND":
      case "OR":
        return ["IN1", "IN2"];
      case "NOT":
      case "TON":
        return ["IN"];
      case "RS":
        return ["SET", "RESET1"];
      case "ADD":
      case "SUB":
      case "MUL":
      case "DIV":
      case "POW":
        return ["IN1", "IN2"];
      case "SQRT":
        return ["IN"];
      case "SETBIT":
      case "RESETBIT":
        return ["IN", "BIT"];
      case "SHL":
      case "SHR":
      case "ROL":
      case "ROR":
        return ["IN", "N"];
      default:
        return [];
    }
  }

  function inputPortsForBlock(block) {
    const t = String(block.type).toUpperCase();
    if (t === "CALL") {
      return callBlockPorts(findProgram(block.params?.program)?.variables).inputs;
    }
    if (t === "LOCAL") {
      return localBlockPorts(findPouVariable(docVariables(), block.params?.name)).inputs;
    }
    return inputPortsForType(block.type);
  }

  function computePortTypes(source) {
    const blocks = new Map((source?.blocks || []).map((b) => [b.id, b]));
    const wires = source?.wires || [];
    const outputTypesMap = buildBlockOutputTypes(blocks, wires);
    const outputs = {};
    for (const [id, type] of outputTypesMap) {
      outputs[id] = type;
    }
    const inputs = {};
    const outputPorts = {};
    for (const block of source?.blocks || []) {
      const t = String(block.type).toUpperCase();
      if (t === "CALL") {
        const vars = findProgram(block.params?.program)?.variables || [];
        const ports = {};
        for (const v of vars) {
          if (v.class === "OUT" || v.class === "IN_OUT") {
            ports[v.name] = v.type || "BOOL";
          }
        }
        outputPorts[block.id] = ports;
      } else if (t === "LOCAL") {
        const v = findPouVariable(docVariables(), block.params?.name);
        if (v) {
          outputPorts[block.id] = { Q: v.type };
          outputs[block.id] = v.type;
        }
      }
      const ports = inputPortsForBlock(block);
      if (ports.length === 0) {
        continue;
      }
      const portMap = {};
      for (const port of ports) {
        portMap[port] = inferInputPortType(block, port, outputTypesMap);
      }
      inputs[block.id] = portMap;
    }
    return { outputs, outputPorts, inputs };
  }

  function typeClassName(type) {
    return `type-${String(type || "BOOL").toLowerCase()}`;
  }

  function outputPortType(blockId, port) {
    const perPort = portTypes.outputPorts?.[blockId];
    if (port && perPort && perPort[port]) {
      return perPort[port];
    }
    return portTypes.outputs[blockId] ?? "BOOL";
  }

  function inputPortType(blockId, port) {
    return portTypes.inputs[blockId]?.[port] ?? "BOOL";
  }

  function wireSourceType(fromBlockId, fromPort, fromKind) {
    if (fromKind === "out") {
      return outputPortType(fromBlockId, fromPort);
    }
    return inputPortType(fromBlockId, fromPort);
  }

  function nextBlockId(type) {
    const base = String(type).toLowerCase().replace(/[^a-z0-9]/g, "_");
    let n = 1;
    const ids = new Set((doc?.blocks || []).map((b) => b.id));
    while (ids.has(`${base}${n}`)) {
      n++;
    }
    return `${base}${n}`;
  }

  function defaultParams(type) {
    const def = findDef(type);
    if (!def?.params) {
      return {};
    }
    const params = {};
    for (const p of def.params) {
      if (p.default !== undefined) {
        params[p.key] = p.default;
      }
    }
    return params;
  }

  function ioKindKey(type) {
    const t = String(type).toUpperCase();
    if (t === "DI") {
      return "di";
    }
    if (t === "AI") {
      return "ai";
    }
    if (t === "DO") {
      return "do";
    }
    return null;
  }

  function ioModulesForType(type) {
    const key = ioKindKey(type);
    if (!key) {
      return [];
    }
    if (ioProfile.modules?.length) {
      return ioProfile.modules
        .map((mod) => ({ id: mod.id, name: mod.name, channels: mod[key] || [] }))
        .filter((mod) => mod.channels.length > 0);
    }
    const channels = ioChannelsForType(type);
    if (channels.length === 0) {
      return [];
    }
    return [{ id: "", name: "Device", channels }];
  }

  function ioChannelsForType(type) {
    const t = String(type).toUpperCase();
    if (t === "DI") {
      return ioProfile.di || [];
    }
    if (t === "AI") {
      return ioProfile.ai || [];
    }
    if (t === "DO") {
      return ioProfile.do || [];
    }
    return [];
  }

  function usedSymbols(type, exceptBlockId) {
    const t = String(type).toUpperCase();
    const used = new Set();
    for (const block of doc?.blocks || []) {
      if (block.type.toUpperCase() !== t || block.id === exceptBlockId) {
        continue;
      }
      const symbol = String(block.params?.symbol || "").trim();
      if (symbol) {
        used.add(symbol);
      }
    }
    return used;
  }

  function resolveBlockIoBinding(block, type) {
    const symbol = String(block.params?.symbol || "").trim();
    const moduleId = String(block.params?.moduleId || "");
    const localChannel = Number(block.params?.channel);

    for (const mod of ioModulesForType(type)) {
      if (moduleId && mod.id !== moduleId) {
        continue;
      }
      for (const entry of mod.channels) {
        if (symbol && entry.symbol === symbol) {
          return { module: mod, entry };
        }
      }
    }

    if (moduleId && Number.isFinite(localChannel) && localChannel >= 1) {
      const mod = ioModulesForType(type).find((m) => m.id === moduleId);
      const entry = mod?.channels.find((c) => c.channel === localChannel);
      if (mod && entry) {
        return { module: mod, entry };
      }
    }

    if (symbol) {
      for (const mod of ioModulesForType(type)) {
        const entry = mod.channels.find((c) => c.symbol === symbol);
        if (entry) {
          return { module: mod, entry };
        }
      }
    }

    return null;
  }

  function firstFreeIoBinding(type) {
    const used = usedSymbols(type, null);
    for (const mod of ioModulesForType(type)) {
      for (const entry of mod.channels) {
        if (!used.has(entry.symbol)) {
          return { module: mod, entry };
        }
      }
    }
    return null;
  }

  function applyIoBinding(block, binding) {
    block.params = block.params || {};
    block.params.moduleId = binding.module.id;
    block.params.channel = binding.entry.channel;
    block.params.symbol = binding.entry.symbol;
  }

  function paramsForNewIoBlock(type) {
    const params = defaultParams(type);
    const free = firstFreeIoBinding(type);
    if (free) {
      params.moduleId = free.module.id;
      params.channel = free.entry.channel;
      params.symbol = free.entry.symbol;
    }
    return params;
  }

  function channelLabel(entry) {
    return `${entry.channel} — ${entry.symbol}`;
  }

  function blockModuleChannelLabel(block, type) {
    const binding = resolveBlockIoBinding(block, type);
    if (binding) {
      return `${binding.module.name} · ${binding.entry.channel} · ${binding.entry.symbol}`;
    }
    const ch = Number(block.params?.channel);
    const symbol = block.params?.symbol ? String(block.params.symbol) : "";
    if (Number.isFinite(ch) && ch >= 1) {
      return symbol ? `${ch} · ${symbol}` : String(ch);
    }
    return symbol || null;
  }

  function applyTransform() {
    el.world.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
  }

  function screenToWorld(clientX, clientY) {
    const rect = el.viewport.getBoundingClientRect();
    const x = (clientX - rect.left - panX) / zoom;
    const y = (clientY - rect.top - panY) / zoom;
    return { x, y };
  }

  function portCenter(blockId, port, kind) {
    const node = el.blocks.querySelector(
      `.fbd-block[data-id="${blockId}"] .port-${kind}[data-port="${port}"]`
    );
    if (!node) {
      const layout = doc?.layout?.[blockId];
      return { x: (layout?.x || 0) + (kind === "out" ? BLOCK_W : 0), y: (layout?.y || 0) + BLOCK_H / 2 };
    }
    const rect = node.getBoundingClientRect();
    return screenToWorld(rect.left + rect.width / 2, rect.top + rect.height / 2);
  }

  function wirePath(from, to) {
    const dx = Math.max(40, Math.abs(to.x - from.x) * 0.5);
    return `M ${from.x} ${from.y} C ${from.x + dx} ${from.y}, ${to.x - dx} ${to.y}, ${to.x} ${to.y}`;
  }

  /** Keep in sync with packages/ir-schema/src/fbdIrNames.ts */
  function sourcePortIrName(block, port) {
    const programId = projectPrograms.currentProgramId || "main";
    const t = String(block.type || "").toUpperCase();
    if (t === "DI") {
      return String(block.params?.symbol || `DI_${block.params?.channel || block.id}`);
    }
    if (t === "AI") {
      return String(block.params?.symbol || `AI_${block.params?.channel || block.id}`);
    }
    if (t === "DO") {
      return String(block.params?.symbol || `DO_${block.params?.channel || block.id}`);
    }
    if (t === "LOCAL") {
      return `${programId}__${String(block.params?.name || "").trim()}`;
    }
    if (t === "CALL") {
      return `__${block.id}_${port}`;
    }
    return `__${block.id}_Q`;
  }

  function liveBool(value) {
    return value === true || value === 1;
  }

  function formatLiveValue(value, type) {
    if (type === "BOOL" || typeof value === "boolean") {
      return liveBool(value) ? "TRUE" : "FALSE";
    }
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return "";
    }
    if (type === "REAL") {
      return String(Math.round(value * 1000) / 1000);
    }
    return String(Math.trunc(value));
  }

  function applyLiveHighlight() {
    const running = Boolean(simLive.running);
    document.body.classList.toggle("sim-live", running);
    if (el.simLiveBadge) {
      el.simLiveBadge.classList.toggle("hidden", !running);
    }
    if (!doc) {
      return;
    }

    el.wires.querySelectorAll(".wire-path:not(.wire-preview)").forEach((path) => {
      path.classList.remove("live-true", "live-false");
      if (!running) {
        return;
      }
      const wire = doc.wires[Number(path.dataset.index)];
      if (!wire) {
        return;
      }
      const from = doc.blocks.find((b) => b.id === wire.from.block);
      if (!from) {
        return;
      }
      const type = outputPortType(wire.from.block, wire.from.port);
      if (type !== "BOOL") {
        return;
      }
      const value = simLive.vars[sourcePortIrName(from, wire.from.port)];
      path.classList.add(liveBool(value) ? "live-true" : "live-false");
    });

    el.blocks.querySelectorAll(".fbd-block").forEach((node) => {
      node.classList.remove("live-true", "live-false");
      const badge = node.querySelector(".live-value");
      node.querySelectorAll(".port-out").forEach((pin) => pin.classList.remove("live-true", "live-false"));
      const block = doc.blocks.find((b) => b.id === node.dataset.id);
      if (!running || !block) {
        if (badge) {
          badge.textContent = "";
          badge.classList.add("hidden");
        }
        return;
      }

      const t = String(block.type).toUpperCase();
      if (t === "CALL") {
        if (badge) {
          badge.textContent = "";
          badge.classList.add("hidden");
        }
        node.querySelectorAll(".port-out").forEach((pin) => {
          const port = pin.dataset.port;
          const type = outputPortType(block.id, port);
          if (type !== "BOOL") {
            return;
          }
          const value = simLive.vars[sourcePortIrName(block, port)];
          pin.classList.add(liveBool(value) ? "live-true" : "live-false");
        });
        return;
      }

      const irName = sourcePortIrName(block, "Q");
      const value = simLive.vars[irName];
      let valueType = outputPortType(block.id, "Q");
      if (t === "DI" || t === "DO") {
        valueType = "BOOL";
      } else if (t === "AI") {
        valueType = "REAL";
      } else if (t === "LOCAL") {
        valueType = findPouVariable(docVariables(), block.params?.name)?.type || valueType;
      }
      if (valueType === "BOOL" && value !== undefined) {
        if (liveBool(value)) {
          node.classList.add("live-true");
        }
      }
      if (badge) {
        const text = value === undefined ? "" : formatLiveValue(value, valueType || "BOOL");
        badge.textContent = text;
        badge.classList.toggle("hidden", !text);
      }
    });
  }

  function renderWires() {
    el.wires.innerHTML = "";
    if (!doc) {
      return;
    }
    doc.wires.forEach((wire, index) => {
      const from = portCenter(wire.from.block, wire.from.port, "out");
      const to = portCenter(wire.to.block, wire.to.port, "in");
      const d = wirePath(from, to);
      const wireType = outputPortType(wire.from.block, wire.from.port);
      const typeClass = typeClassName(wireType);
      const selected = selectedWireIndex === index;

      const hit = document.createElementNS("http://www.w3.org/2000/svg", "path");
      hit.setAttribute("d", d);
      hit.setAttribute("class", "wire-hit");
      hit.dataset.index = String(index);
      hit.style.pointerEvents = "stroke";
      hit.addEventListener("mousedown", (ev) => {
        ev.stopPropagation();
        selectWire(index);
      });
      hit.addEventListener("dblclick", (ev) => {
        ev.stopPropagation();
        deleteWire(index);
      });

      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", d);
      path.setAttribute("class", `wire-path ${typeClass}${selected ? " selected" : ""}`);
      path.dataset.index = String(index);
      path.style.pointerEvents = "none";

      el.wires.appendChild(hit);
      el.wires.appendChild(path);
    });

    if (wireDrag && wireDrag.moved) {
      const a = wireDrag.from.kind === "out" ? wireDrag.start : wireDrag.cursor;
      const b = wireDrag.from.kind === "out" ? wireDrag.cursor : wireDrag.start;
      const previewType = wireSourceType(wireDrag.from.block, wireDrag.from.port, wireDrag.from.kind);
      const preview = document.createElementNS("http://www.w3.org/2000/svg", "path");
      preview.setAttribute("d", wirePath(a, b));
      preview.setAttribute("class", `wire-path wire-preview ${typeClassName(previewType)}`);
      preview.style.pointerEvents = "none";
      el.wires.appendChild(preview);
    }
    applyLiveHighlight();
  }

  function blockSubtitle(block) {
    const t = String(block.type).toUpperCase();
    if (t === "CALL") {
      return "";
    }
    if (t === "LOCAL") {
      const v = findPouVariable(docVariables(), block.params?.name);
      return v ? `${v.class} · ${v.type}` : String(block.params?.name || "");
    }
    if ((t === "DI" || t === "DO" || t === "AI") && (block.params?.symbol || block.params?.channel !== undefined)) {
      const label = blockModuleChannelLabel(block, t);
      if (label) {
        return label;
      }
    }
    if (t === "CONST") {
      return formatConstSubtitle(block.params);
    }
    if (block.params?.symbol) {
      return String(block.params.symbol);
    }
    if (block.params?.pt_ms !== undefined) {
      return `PT ${block.params.pt_ms} ms`;
    }
    return "";
  }

  function constDataType(params) {
    const raw = String(params?.data_type ?? params?.type ?? "BOOL").toUpperCase();
    const allowed = ["BOOL", "INT", "DINT", "UINT", "WORD", "REAL"];
    return allowed.includes(raw) ? raw : "BOOL";
  }

  function formatConstSubtitle(params) {
    const dataType = constDataType(params);
    if (dataType === "BOOL") {
      return `${dataType} · ${formatBoolConst(params?.value)}`;
    }
    const n = Number(params?.value);
    const shown = Number.isFinite(n) ? String(params?.value ?? 0) : "0";
    return `${dataType} · ${shown}`;
  }

  function formatBoolConst(value) {
    if (typeof value === "boolean") {
      return value ? "TRUE" : "FALSE";
    }
    if (typeof value === "number") {
      return value !== 0 ? "TRUE" : "FALSE";
    }
    if (typeof value === "string") {
      const s = value.trim().toLowerCase();
      return s === "true" || s === "1" || s === "on" ? "TRUE" : "FALSE";
    }
    return "FALSE";
  }

  function parseBoolParam(value) {
    if (typeof value === "boolean") {
      return value;
    }
    if (typeof value === "number") {
      return value !== 0;
    }
    if (typeof value === "string") {
      const s = value.trim().toLowerCase();
      return s === "true" || s === "1" || s === "on";
    }
    return false;
  }

  function defaultValueForType(dataType) {
    return dataType === "BOOL" ? false : 0;
  }

  /** Vertical position (%) for pins: one centered, multiple spaced vertically. */
  function portTopPercent(index, total) {
    if (total <= 1) {
      return 50;
    }
    const top = 32;
    const bottom = 72;
    return top + (index * (bottom - top)) / (total - 1);
  }

  function blockBodyHeight(inputCount, outputCount) {
    const portCount = Math.max(inputCount, outputCount, 1);
    return Math.max(28, portCount * 22 + 6);
  }

  function createPortRow(block, portName, kind, index, total, type) {
    const row = document.createElement("div");
    row.className = `port-row port-${kind}-row`;
    row.style.top = `${portTopPercent(index, total)}%`;

    const label = document.createElement("span");
    label.className = "port-label";
    label.textContent = portName;

    const pin = document.createElement("div");
    pin.className = `port port-${kind} ${typeClassName(type)}`;
    pin.dataset.port = portName;
    pin.title = `${portName} (${type})`;
    pin.addEventListener("mousedown", (ev) => startWireDrag(ev, block.id, portName, kind));
    pin.addEventListener("click", (ev) => onPortClick(ev, block.id, portName, kind));

    if (kind === "in") {
      row.appendChild(pin);
      row.appendChild(label);
    } else {
      row.appendChild(label);
      row.appendChild(pin);
    }
    return row;
  }

  function renderBlocks() {
    el.blocks.innerHTML = "";
    if (!doc) {
      return;
    }
    for (const block of doc.blocks) {
    const def = findDef(block.type, block);
      const pos = doc.layout[block.id] || { x: 48, y: 48 };
      const inputs = def?.inputs || [];
      const outputs = def?.outputs || [];
      const subtitle = blockSubtitle(block);

      const div = document.createElement("div");
      div.className =
        "fbd-block cat-" +
        (def?.category || "logic") +
        (selectedBlockId === block.id ? " selected" : "");
      div.dataset.id = block.id;
      div.style.left = `${pos.x}px`;
      div.style.top = `${pos.y}px`;

      const head = document.createElement("div");
      head.className = "block-head";
      head.textContent = def?.label || block.type;
      div.appendChild(head);

      const body = document.createElement("div");
      body.className = "block-body";
      body.style.minHeight = `${blockBodyHeight(inputs.length, outputs.length)}px`;

      const ports = document.createElement("div");
      ports.className = "ports";
      for (let i = 0; i < inputs.length; i++) {
        const p = inputs[i];
        ports.appendChild(
          createPortRow(block, p, "in", i, inputs.length, inputPortType(block.id, p))
        );
      }
      for (let i = 0; i < outputs.length; i++) {
        const p = outputs[i];
        ports.appendChild(
          createPortRow(block, p, "out", i, outputs.length, outputPortType(block.id, p))
        );
      }
      body.appendChild(ports);
      div.appendChild(body);

      if (subtitle) {
        const sub = document.createElement("div");
        sub.className = "block-sub";
        sub.textContent = subtitle;
        div.appendChild(sub);
      }

      const live = document.createElement("div");
      live.className = "live-value hidden";
      div.appendChild(live);

      div.addEventListener("mousedown", (ev) => {
        if (ev.button !== 0 || ev.target.classList.contains("port")) {
          return;
        }
        ev.stopPropagation();
        selectedBlockId = block.id;
        selectedWireIndex = null;
        selectedVarName = null;
        startBlockDrag(ev, block.id);
        renderProperties();
        renderBlocks();
        renderWires();
      });

      el.blocks.appendChild(div);
    }
    highlightWirePorts();
    applyLiveHighlight();
  }

  function highlightWirePorts() {
    document.querySelectorAll(".port").forEach((p) => {
      p.classList.remove("wire-source", "wire-target-ok");
    });
    if (!wireFrom) {
      el.wireHint.classList.add("hidden");
      return;
    }
    el.wireHint.classList.remove("hidden");
    const src = el.blocks.querySelector(
      `.fbd-block[data-id="${wireFrom.block}"] .port-out[data-port="${wireFrom.port}"]`
    );
    if (src) {
      src.classList.add("wire-source");
    }
    document.querySelectorAll(".port-in").forEach((p) => {
      p.classList.add("wire-target-ok");
    });
  }

  function onPortClick(ev, blockId, port, kind) {
    ev.stopPropagation();
    if (kind === "out") {
      wireFrom = { block: blockId, port };
      highlightWirePorts();
      return;
    }
    if (!wireFrom) {
      return;
    }
    if (wireFrom.block === blockId) {
      wireFrom = null;
      highlightWirePorts();
      return;
    }
    addWire({ block: wireFrom.block, port: wireFrom.port }, { block: blockId, port });
    wireFrom = null;
    highlightWirePorts();
  }

  function portInfoFromElement(node) {
    if (!node || !node.classList || !node.classList.contains("port")) {
      return null;
    }
    const blockEl = node.closest(".fbd-block");
    if (!blockEl) {
      return null;
    }
    return {
      block: blockEl.dataset.id,
      port: node.dataset.port,
      kind: node.classList.contains("port-out") ? "out" : "in",
    };
  }

  function setDragTargets(sourceKind) {
    const targetSelector = sourceKind === "out" ? ".port-in" : ".port-out";
    document.querySelectorAll(".port").forEach((p) => p.classList.remove("wire-drag-ok"));
    document.querySelectorAll(targetSelector).forEach((p) => p.classList.add("wire-drag-ok"));
  }

  function clearDragTargets() {
    document.querySelectorAll(".port").forEach((p) => p.classList.remove("wire-drag-ok"));
  }

  function addWire(out, inp) {
    if (!doc || !out || !inp || out.block === inp.block) {
      return false;
    }
    const alreadyConnected = doc.wires.some(
      (w) =>
        w.from.block === out.block &&
        w.from.port === out.port &&
        w.to.block === inp.block &&
        w.to.port === inp.port
    );
    if (alreadyConnected) {
      return false;
    }
    // Each input accepts only one connection: drop any wire already targeting it.
    doc.wires = doc.wires.filter((w) => !(w.to.block === inp.block && w.to.port === inp.port));
    doc.wires.push({
      from: { block: out.block, port: out.port },
      to: { block: inp.block, port: inp.port },
    });
    commit();
    return true;
  }

  function tryCreateWire(a, b) {
    if (!a || !b || a.block === b.block) {
      return false;
    }
    if (a.kind === "out" && b.kind === "in") {
      return addWire(a, b);
    }
    if (a.kind === "in" && b.kind === "out") {
      return addWire(b, a);
    }
    return false;
  }

  function startWireDrag(ev, blockId, port, kind) {
    if (ev.button !== 0) {
      return;
    }
    ev.stopPropagation();
    ev.preventDefault();
    const start = portCenter(blockId, port, kind);
    wireDrag = {
      from: { block: blockId, port, kind },
      start,
      cursor: { ...start },
      moved: false,
    };
    setDragTargets(kind);

    function onMove(e) {
      wireDrag.cursor = screenToWorld(e.clientX, e.clientY);
      if (!wireDrag.moved) {
        const dx = Math.abs(e.clientX - (ev.clientX || 0));
        const dy = Math.abs(e.clientY - (ev.clientY || 0));
        if (dx + dy > 3) {
          wireDrag.moved = true;
        }
      }
      renderWires();
    }

    function onUp(e) {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      const fromDrag = wireDrag.from;
      const dragged = wireDrag.moved;
      wireDrag = null;
      clearDragTargets();
      if (dragged) {
        const target = portInfoFromElement(document.elementFromPoint(e.clientX, e.clientY));
        const created = tryCreateWire(fromDrag, target);
        // Suppress the trailing click so it doesn't start a click-to-connect.
        wireFrom = null;
        if (!created) {
          renderWires();
        }
      }
    }

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  function selectWire(index) {
    selectedWireIndex = index;
    selectedBlockId = null;
    selectedVarName = null;
    // Update selection styling in place; do NOT recreate wire elements,
    // otherwise a following dblclick (for deletion) would target a stale node.
    el.wires.querySelectorAll(".wire-path").forEach((p) => {
      p.classList.toggle("selected", Number(p.dataset.index) === index);
    });
    renderBlocks();
    renderProperties();
  }

  function deleteWire(index) {
    if (!doc || index === null || index < 0 || index >= doc.wires.length) {
      return;
    }
    doc.wires.splice(index, 1);
    selectedWireIndex = null;
    commit();
  }

  function renderWireProperties() {
    const wire = doc.wires[selectedWireIndex];
    if (!wire) {
      selectedWireIndex = null;
      el.properties.innerHTML = "<p class=\"muted\">Select a block or a connection</p>";
      return;
    }
    const fromRow = document.createElement("div");
    fromRow.className = "prop-row";
    fromRow.innerHTML = `<label>From</label><input readonly value="${wire.from.block} . ${wire.from.port}" />`;
    el.properties.appendChild(fromRow);

    const toRow = document.createElement("div");
    toRow.className = "prop-row";
    toRow.innerHTML = `<label>To</label><input readonly value="${wire.to.block} . ${wire.to.port}" />`;
    el.properties.appendChild(toRow);

    const del = document.createElement("button");
    del.className = "btn-danger";
    del.textContent = "Delete connection";
    del.addEventListener("click", () => deleteWire(selectedWireIndex));
    el.properties.appendChild(del);
  }

  function renderChannelParam(block, paramDef) {
    const row = document.createElement("div");
    row.className = "prop-row prop-row-io";
    const label = document.createElement("label");
    label.textContent = paramDef.label;
    row.appendChild(label);

    const group = document.createElement("div");
    group.className = "prop-io-group";

    const moduleSelect = document.createElement("select");
    moduleSelect.className = "prop-io-module";
    const channelSelect = document.createElement("select");
    channelSelect.className = "prop-io-channel";

    const modules = ioModulesForType(block.type);
    const used = usedSymbols(block.type, block.id);
    const binding = resolveBlockIoBinding(block, block.type);
    let currentModuleId = binding?.module.id ?? String(block.params?.moduleId || "");
    let currentChannel = binding?.entry.channel ?? Number(block.params?.channel);

    const moduleEmpty = document.createElement("option");
    moduleEmpty.value = "";
    moduleEmpty.textContent = modules.length ? "Select module…" : "No modules";
    moduleSelect.appendChild(moduleEmpty);

    if (modules.length === 0) {
      moduleSelect.disabled = true;
      channelSelect.disabled = true;
    }

    for (const mod of modules) {
      const opt = document.createElement("option");
      opt.value = mod.id;
      opt.textContent = mod.name;
      if (mod.id === currentModuleId) {
        opt.selected = true;
      }
      moduleSelect.appendChild(opt);
    }

    function fillChannelSelect() {
      channelSelect.innerHTML = "";
      const channelEmpty = document.createElement("option");
      channelEmpty.value = "";
      channelEmpty.textContent = "Select channel…";
      channelSelect.appendChild(channelEmpty);

      const mod = modules.find((m) => m.id === moduleSelect.value);
      if (!mod) {
        channelSelect.disabled = true;
        return;
      }

      channelSelect.disabled = false;
      for (const entry of mod.channels) {
        const opt = document.createElement("option");
        opt.value = String(entry.channel);
        opt.textContent = channelLabel(entry);
        const taken = used.has(entry.symbol);
        if (taken && entry.symbol !== binding?.entry.symbol) {
          opt.disabled = true;
          opt.textContent += " (in use)";
        }
        if (entry.channel === currentChannel && mod.id === currentModuleId) {
          opt.selected = true;
        }
        channelSelect.appendChild(opt);
      }

      if (
        Number.isFinite(currentChannel) &&
        currentChannel >= 1 &&
        mod.id === currentModuleId &&
        !mod.channels.some((c) => c.channel === currentChannel)
      ) {
        const orphan = document.createElement("option");
        orphan.value = String(currentChannel);
        orphan.textContent = `${currentChannel} — ${block.params?.symbol || "unmapped"} (not on module)`;
        orphan.selected = true;
        channelSelect.appendChild(orphan);
      }
    }

    fillChannelSelect();

    function onIoSelectionChange() {
      block.params = block.params || {};
      const mod = modules.find((m) => m.id === moduleSelect.value);
      if (!mod || !channelSelect.value) {
        delete block.params.moduleId;
        delete block.params.channel;
        delete block.params.symbol;
        commit();
        return;
      }
      const localChannel = Number(channelSelect.value);
      const entry = mod.channels.find((c) => c.channel === localChannel);
      block.params.moduleId = mod.id;
      block.params.channel = localChannel;
      block.params.symbol = entry?.symbol || `${String(block.type).toUpperCase()}_${localChannel}`;
      currentModuleId = mod.id;
      currentChannel = localChannel;
      commit();
    }

    moduleSelect.addEventListener("change", () => {
      block.params = block.params || {};
      currentModuleId = moduleSelect.value;
      currentChannel = NaN;
      if (moduleSelect.value) {
        block.params.moduleId = moduleSelect.value;
      } else {
        delete block.params.moduleId;
      }
      delete block.params.channel;
      delete block.params.symbol;
      fillChannelSelect();
      commit();
    });
    channelSelect.addEventListener("change", onIoSelectionChange);

    group.appendChild(moduleSelect);
    group.appendChild(channelSelect);
    row.appendChild(group);

    if (ioProfile.source === "none") {
      const hint = document.createElement("p");
      hint.className = "prop-hint";
      hint.textContent = "Open a NanoPLC project with a device catalog or io-map.json to list channels.";
      row.appendChild(hint);
    } else {
      const totalChannels = modules.reduce((sum, mod) => sum + mod.channels.length, 0);
      if (totalChannels > 0 && used.size >= totalChannels && !binding) {
        const hint = document.createElement("p");
        hint.className = "prop-hint";
        hint.textContent = "All channels of this type are already assigned.";
        row.appendChild(hint);
      }
    }

    el.properties.appendChild(row);
  }

  function renderPlcTypeParam(block, paramDef) {
    const row = document.createElement("div");
    row.className = "prop-row";
    const label = document.createElement("label");
    label.textContent = paramDef.label;
    const select = document.createElement("select");
    const current = constDataType(block.params);
    for (const t of ["BOOL", "INT", "DINT", "UINT", "WORD", "REAL"]) {
      const opt = document.createElement("option");
      opt.value = t;
      opt.textContent = t;
      if (t === current) {
        opt.selected = true;
      }
      select.appendChild(opt);
    }
    select.addEventListener("change", () => {
      block.params = block.params || {};
      const nextType = select.value;
      const prevType = constDataType(block.params);
      block.params.data_type = nextType;
      if (prevType === "BOOL" && nextType !== "BOOL") {
        block.params.value = 0;
      } else if (prevType !== "BOOL" && nextType === "BOOL") {
        block.params.value = false;
      } else if (block.params.value === undefined) {
        block.params.value = defaultValueForType(nextType);
      }
      commit();
    });
    row.appendChild(label);
    row.appendChild(select);
    el.properties.appendChild(row);
  }

  function renderConstValueParam(block, paramDef) {
    const row = document.createElement("div");
    row.className = "prop-row";
    const label = document.createElement("label");
    label.textContent = paramDef.label;
    row.appendChild(label);

    const dataType = constDataType(block.params);
    if (dataType === "BOOL") {
      const select = document.createElement("select");
      const current = parseBoolParam(block.params?.value ?? false);
      for (const [val, text] of [
        [false, "FALSE"],
        [true, "TRUE"],
      ]) {
        const opt = document.createElement("option");
        opt.value = val ? "true" : "false";
        opt.textContent = text;
        if (val === current) {
          opt.selected = true;
        }
        select.appendChild(opt);
      }
      select.addEventListener("change", () => {
        block.params = block.params || {};
        block.params.value = select.value === "true";
        commit();
      });
      row.appendChild(select);
    } else {
      const input = document.createElement("input");
      input.type = "number";
      if (dataType === "REAL") {
        input.step = "any";
      } else {
        input.step = "1";
      }
      const n = Number(block.params?.value);
      input.value = Number.isFinite(n) ? String(block.params.value) : "0";
      input.addEventListener("change", () => {
        block.params = block.params || {};
        const parsed = Number(input.value);
        block.params.value = Number.isFinite(parsed)
          ? dataType === "REAL"
            ? parsed
            : Math.trunc(parsed)
          : 0;
        commit();
      });
      row.appendChild(input);
    }

    el.properties.appendChild(row);
  }

  function nextVarName(className) {
    const prefix =
      className === "IN_OUT"
        ? "InOut"
        : className === "TEMP"
          ? "Temp"
          : className.charAt(0) + className.slice(1).toLowerCase();
    const taken = new Set(docVariables().map((v) => String(v.name).toUpperCase()));
    let n = 1;
    while (taken.has(`${prefix}${n}`.toUpperCase())) {
      n++;
    }
    return `${prefix}${n}`;
  }

  function addVariable(className) {
    if (!doc) {
      return;
    }
    if (!Array.isArray(doc.variables)) {
      doc.variables = [];
    }
    const name = nextVarName(className);
    doc.variables.push({ name, class: className, type: "BOOL" });
    selectedVarName = name;
    selectedBlockId = null;
    selectedWireIndex = null;
    commit();
  }

  function renameVariable(oldName, newName) {
    const trimmed = String(newName || "").trim();
    if (!trimmed || trimmed === oldName) {
      return;
    }
    const taken = docVariables().some(
      (v) => v.name !== oldName && String(v.name).toUpperCase() === trimmed.toUpperCase()
    );
    if (taken) {
      return;
    }
    const v = findPouVariable(doc.variables, oldName);
    if (!v) {
      return;
    }
    v.name = trimmed;
    for (const block of doc.blocks) {
      if (String(block.type).toUpperCase() === "LOCAL" && String(block.params?.name) === oldName) {
        block.params.name = trimmed;
      }
    }
    selectedVarName = trimmed;
    commit();
  }

  function renderVariableProperties() {
    const v = findPouVariable(docVariables(), selectedVarName);
    if (!v) {
      el.properties.innerHTML = "<p class=\"muted\">Select a block, variable, or connection</p>";
      return;
    }
    const desc = document.createElement("p");
    desc.className = "block-description";
    desc.textContent =
      "Program variable. IN, IN_OUT, and OUT appear as ports on CALL blocks. Drag the name from the palette onto the canvas to use it.";
    el.properties.appendChild(desc);

    const nameRow = document.createElement("div");
    nameRow.className = "prop-row";
    nameRow.innerHTML = "<label>Name</label>";
    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.value = v.name;
    nameInput.addEventListener("change", () => renameVariable(v.name, nameInput.value));
    nameRow.appendChild(nameInput);
    el.properties.appendChild(nameRow);

    const classRow = document.createElement("div");
    classRow.className = "prop-row";
    classRow.innerHTML = "<label>Class</label>";
    const classSelect = document.createElement("select");
    for (const cls of ["IN", "IN_OUT", "OUT", "VAR", "TEMP"]) {
      const opt = document.createElement("option");
      opt.value = cls;
      opt.textContent = cls;
      if (cls === v.class) {
        opt.selected = true;
      }
      classSelect.appendChild(opt);
    }
    classSelect.addEventListener("change", () => {
      v.class = classSelect.value;
      commit();
    });
    classRow.appendChild(classSelect);
    el.properties.appendChild(classRow);

    const typeRow = document.createElement("div");
    typeRow.className = "prop-row";
    typeRow.innerHTML = "<label>Type</label>";
    const typeSelect = document.createElement("select");
    for (const t of ["BOOL", "INT", "DINT", "UINT", "WORD", "REAL"]) {
      const opt = document.createElement("option");
      opt.value = t;
      opt.textContent = t;
      if (t === v.type) {
        opt.selected = true;
      }
      typeSelect.appendChild(opt);
    }
    typeSelect.addEventListener("change", () => {
      v.type = typeSelect.value;
      if (v.type === "BOOL") {
        v.initial = v.initial === true || v.initial === 1;
      } else if (typeof v.initial !== "number") {
        v.initial = 0;
      }
      commit();
    });
    typeRow.appendChild(typeSelect);
    el.properties.appendChild(typeRow);

    const initRow = document.createElement("div");
    initRow.className = "prop-row";
    initRow.innerHTML = "<label>Initial</label>";
    if (v.type === "BOOL") {
      const select = document.createElement("select");
      const current = v.initial === true || v.initial === 1;
      for (const [val, text] of [
        [false, "FALSE"],
        [true, "TRUE"],
      ]) {
        const opt = document.createElement("option");
        opt.value = val ? "true" : "false";
        opt.textContent = text;
        if (val === current) {
          opt.selected = true;
        }
        select.appendChild(opt);
      }
      select.addEventListener("change", () => {
        v.initial = select.value === "true";
        commit();
      });
      initRow.appendChild(select);
    } else {
      const input = document.createElement("input");
      input.type = "number";
      input.step = v.type === "REAL" ? "any" : "1";
      const n = Number(v.initial);
      input.value = Number.isFinite(n) ? String(v.initial) : "0";
      input.addEventListener("change", () => {
        const parsed = Number(input.value);
        v.initial = Number.isFinite(parsed) ? (v.type === "REAL" ? parsed : Math.trunc(parsed)) : 0;
        commit();
      });
      initRow.appendChild(input);
    }
    el.properties.appendChild(initRow);

    const del = document.createElement("button");
    del.className = "btn-danger";
    del.textContent = "Delete variable";
    del.addEventListener("click", () => {
      const name = v.name;
      doc.variables = docVariables().filter((x) => x.name !== name);
      for (const block of doc.blocks) {
        if (String(block.type).toUpperCase() === "LOCAL" && String(block.params?.name) === name) {
          delete block.params.name;
        }
      }
      selectedVarName = null;
      commit();
    });
    el.properties.appendChild(del);
  }

  function renderProperties() {
    el.properties.innerHTML = "";
    if (!doc) {
      el.properties.innerHTML = "<p class=\"muted\">Select a block or a connection</p>";
      return;
    }
    if (selectedWireIndex !== null) {
      renderWireProperties();
      return;
    }
    if (selectedVarName) {
      renderVariableProperties();
      return;
    }
    if (!selectedBlockId) {
      el.properties.innerHTML = "<p class=\"muted\">Select a block, variable, or connection</p>";
      return;
    }
    const block = doc.blocks.find((b) => b.id === selectedBlockId);
    if (!block) {
      return;
    }
    const def = findDef(block.type, block);

    if (def?.description) {
      const desc = document.createElement("p");
      desc.className = "block-description";
      desc.textContent = def.description;
      el.properties.appendChild(desc);
    }

    const idRow = document.createElement("div");
    idRow.className = "prop-row";
    idRow.innerHTML = `<label>ID</label><input readonly value="${block.id}" />`;
    el.properties.appendChild(idRow);

    if (String(block.type).toUpperCase() === "CALL") {
      const row = document.createElement("div");
      row.className = "prop-row";
      const label = document.createElement("label");
      label.textContent = "Program";
      row.appendChild(label);
      const select = document.createElement("select");
      const options = callablePrograms();
      const current = String(block.params?.program ?? "");
      if (current && !options.some((p) => p.id === current)) {
        const orphan = document.createElement("option");
        orphan.value = current;
        orphan.textContent = `${current} (missing)`;
        orphan.selected = true;
        select.appendChild(orphan);
      }
      for (const prog of options) {
        const opt = document.createElement("option");
        opt.value = prog.id;
        opt.textContent = prog.name;
        if (prog.id === current) {
          opt.selected = true;
        }
        select.appendChild(opt);
      }
      select.addEventListener("change", () => {
        block.params = block.params || {};
        block.params.program = select.value;
        commit();
      });
      row.appendChild(select);
      el.properties.appendChild(row);
    }

    if (String(block.type).toUpperCase() === "LOCAL") {
      const row = document.createElement("div");
      row.className = "prop-row";
      const label = document.createElement("label");
      label.textContent = "Variable";
      row.appendChild(label);
      const select = document.createElement("select");
      const current = String(block.params?.name ?? "");
      if (current && !findPouVariable(docVariables(), current)) {
        const orphan = document.createElement("option");
        orphan.value = current;
        orphan.textContent = `${current} (missing)`;
        orphan.selected = true;
        select.appendChild(orphan);
      }
      for (const v of docVariables()) {
        const opt = document.createElement("option");
        opt.value = v.name;
        opt.textContent = `${v.name} (${v.class} ${v.type})`;
        if (v.name === current) {
          opt.selected = true;
        }
        select.appendChild(opt);
      }
      select.addEventListener("change", () => {
        block.params = block.params || {};
        block.params.name = select.value;
        commit();
      });
      row.appendChild(select);
      el.properties.appendChild(row);
    }

    for (const p of def?.params || []) {
      if (p.type === "channel") {
        renderChannelParam(block, p);
        continue;
      }
      if (p.type === "plc_type") {
        renderPlcTypeParam(block, p);
        continue;
      }
      if (p.type === "const_value") {
        renderConstValueParam(block, p);
        continue;
      }
      const row = document.createElement("div");
      row.className = "prop-row";
      const label = document.createElement("label");
      label.textContent = p.label;
      row.appendChild(label);

      if (p.type === "boolean") {
        const select = document.createElement("select");
        const current = parseBoolParam(block.params?.[p.key] ?? p.default);
        for (const [val, text] of [
          [false, "FALSE"],
          [true, "TRUE"],
        ]) {
          const opt = document.createElement("option");
          opt.value = val ? "true" : "false";
          opt.textContent = text;
          if (val === current) {
            opt.selected = true;
          }
          select.appendChild(opt);
        }
        select.addEventListener("change", () => {
          block.params = block.params || {};
          block.params[p.key] = select.value === "true";
          commit();
        });
        row.appendChild(select);
      } else {
        const input = document.createElement("input");
        input.type = p.type === "number" ? "number" : "text";
        input.value = block.params?.[p.key] ?? p.default ?? "";
        input.addEventListener("change", () => {
          block.params = block.params || {};
          block.params[p.key] = p.type === "number" ? Number(input.value) : input.value;
          commit();
        });
        row.appendChild(input);
      }
      el.properties.appendChild(row);
    }

    const t = String(block.type).toUpperCase();
    if ((t === "DI" || t === "DO" || t === "AI") && block.params?.symbol) {
      const symRow = document.createElement("div");
      symRow.className = "prop-row";
      symRow.innerHTML = `<label>Symbol</label><input readonly value="${String(block.params.symbol)}" />`;
      el.properties.appendChild(symRow);
    }

    const del = document.createElement("button");
    del.className = "btn-danger";
    del.textContent = "Delete block";
    del.addEventListener("click", () => {
      doc.blocks = doc.blocks.filter((b) => b.id !== selectedBlockId);
      doc.wires = doc.wires.filter(
        (w) => w.from.block !== selectedBlockId && w.to.block !== selectedBlockId
      );
      delete doc.layout[selectedBlockId];
      selectedBlockId = null;
      commit();
    });
    el.properties.appendChild(del);
  }

  function renderPalette() {
    const groups = { io: [], logic: [], timer: [], math: [], bit: [] };
    for (const item of catalog) {
      (groups[item.category] || groups.logic).push(item);
    }
    el.palette.innerHTML = "";

    const varWrap = document.createElement("div");
    varWrap.className = "palette-group";
    varWrap.innerHTML = `<div class="palette-group-title">Variables</div>`;
    const addRow = document.createElement("div");
    addRow.className = "var-add-row";
    for (const cls of ["IN", "IN_OUT", "OUT", "VAR", "TEMP"]) {
      const addBtn = document.createElement("button");
      addBtn.type = "button";
      addBtn.className = "var-add-btn";
      addBtn.textContent = `+ ${cls}`;
      addBtn.title = `Add ${cls} variable`;
      addBtn.addEventListener("click", () => addVariable(cls));
      addRow.appendChild(addBtn);
    }
    varWrap.appendChild(addRow);
    const vars = docVariables();
    if (vars.length === 0) {
      const empty = document.createElement("div");
      empty.className = "muted";
      empty.style.padding = "4px 8px";
      empty.textContent = "Add IN / OUT ports for CALL boxes.";
      varWrap.appendChild(empty);
    }
    for (const v of vars) {
      const btn = document.createElement("button");
      btn.className = "palette-item var-item" + (selectedVarName === v.name ? " selected" : "");
      btn.type = "button";
      btn.textContent = v.name;
      btn.title = `${v.class} ${v.type} — drag onto the canvas`;
      const meta = document.createElement("span");
      meta.className = "var-item-meta";
      meta.textContent = `${v.class} · ${v.type}`;
      btn.appendChild(meta);
      btn.addEventListener("click", () => {
        selectedVarName = v.name;
        selectedBlockId = null;
        selectedWireIndex = null;
        renderPalette();
        renderProperties();
        renderBlocks();
      });
      btn.addEventListener("dragstart", (ev) => {
        ev.dataTransfer.setData("text/nanoplc-block", "LOCAL");
        ev.dataTransfer.setData("text/nanoplc-local-var", v.name);
      });
      btn.draggable = true;
      varWrap.appendChild(btn);
    }
    el.palette.appendChild(varWrap);

    for (const [cat, title] of [
      ["io", "I/O"],
      ["logic", "Logic"],
      ["timer", "Timers"],
      ["math", "Math"],
      ["bit", "Bits"],
    ]) {
      const wrap = document.createElement("div");
      wrap.className = "palette-group";
      wrap.innerHTML = `<div class="palette-group-title">${title}</div>`;
      for (const item of groups[cat] || []) {
        const btn = document.createElement("button");
        btn.className = "palette-item";
        btn.type = "button";
        btn.textContent = item.label;
        btn.addEventListener("click", () => addBlock(item.type));
        btn.addEventListener("dragstart", (ev) => {
          ev.dataTransfer.setData("text/nanoplc-block", item.type);
        });
        btn.draggable = true;
        wrap.appendChild(btn);
      }
      el.palette.appendChild(wrap);
    }

    const programs = callablePrograms();
    const wrap = document.createElement("div");
    wrap.className = "palette-group";
    wrap.innerHTML = `<div class="palette-group-title">Programs</div>`;
    if (programs.length === 0) {
      const empty = document.createElement("div");
      empty.className = "muted";
      empty.style.padding = "4px 8px";
      empty.textContent = "Add another program to call it here.";
      wrap.appendChild(empty);
    }
    for (const prog of programs) {
      const btn = document.createElement("button");
      btn.className = "palette-item";
      btn.type = "button";
      btn.textContent = prog.name;
      btn.title = `Call PROGRAM ${prog.name}`;
      btn.addEventListener("click", () => addBlock("CALL", undefined, { program: prog.id }));
      btn.addEventListener("dragstart", (ev) => {
        ev.dataTransfer.setData("text/nanoplc-block", "CALL");
        ev.dataTransfer.setData("text/nanoplc-call-program", prog.id);
      });
      btn.draggable = true;
      wrap.appendChild(btn);
    }
    el.palette.appendChild(wrap);
  }

  function addBlock(type, at, extraParams) {
    if (!doc) {
      return;
    }
    const id = nextBlockId(type);
    const center = at || {
      x: (-panX + el.viewport.clientWidth / 2) / zoom - BLOCK_W / 2,
      y: (-panY + el.viewport.clientHeight / 2) / zoom - BLOCK_H / 2,
    };
    const upper = String(type).toUpperCase();
    const params =
      upper === "DI" || upper === "DO" || upper === "AI"
        ? paramsForNewIoBlock(type)
        : { ...defaultParams(type), ...(extraParams || {}) };
    doc.blocks.push({ id, type: upper, params });
    doc.layout[id] = { x: Math.round(center.x), y: Math.round(center.y) };
    selectedBlockId = id;
    selectedWireIndex = null;
    selectedVarName = null;
    commit();
  }

  function startBlockDrag(ev, blockId) {
    const startX = ev.clientX;
    const startY = ev.clientY;
    const pos = { ...doc.layout[blockId] };

    function onMove(e) {
      doc.layout[blockId] = {
        x: Math.round(pos.x + (e.clientX - startX) / zoom),
        y: Math.round(pos.y + (e.clientY - startY) / zoom),
      };
      renderBlocks();
      renderWires();
    }

    function onUp() {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      commit();
    }

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  function setupPanZoom() {
    let panning = false;
    let panStart = { x: 0, y: 0 };
    let panOrigin = { x: 0, y: 0 };

    el.viewport.addEventListener("mousedown", (ev) => {
      if (ev.button !== 1 && ev.button !== 0) {
        return;
      }
      if (ev.target.closest(".fbd-block") || ev.target.classList.contains("port")) {
        return;
      }
      if (ev.button === 0) {
        selectedBlockId = null;
        selectedWireIndex = null;
        selectedVarName = null;
        wireFrom = null;
        renderProperties();
        renderBlocks();
        renderWires();
      }
      panning = true;
      el.viewport.classList.add("panning");
      panStart = { x: ev.clientX, y: ev.clientY };
      panOrigin = { x: panX, y: panY };
      ev.preventDefault();
    });

    window.addEventListener("mousemove", (ev) => {
      if (!panning) {
        return;
      }
      panX = panOrigin.x + (ev.clientX - panStart.x);
      panY = panOrigin.y + (ev.clientY - panStart.y);
      applyTransform();
    });

    window.addEventListener("mouseup", () => {
      panning = false;
      el.viewport.classList.remove("panning");
    });

    el.viewport.addEventListener(
      "wheel",
      (ev) => {
        ev.preventDefault();
        const rect = el.viewport.getBoundingClientRect();
        const mx = ev.clientX - rect.left;
        const my = ev.clientY - rect.top;
        const worldBefore = screenToWorld(ev.clientX, ev.clientY);

        // Normalize to pixels (mouse notch ≈ 100px; trackpad sends small deltas).
        let dy = ev.deltaY;
        if (ev.deltaMode === 1) {
          dy *= 16;
        } else if (ev.deltaMode === 2) {
          dy *= rect.height;
        }
        // ~4–5% per mouse notch; smooth for trackpad pixel deltas.
        const factor = Math.exp(-dy * 0.00045);
        const next = Math.min(2.5, Math.max(0.35, zoom * factor));
        if (next === zoom) {
          return;
        }
        zoom = next;
        panX = mx - worldBefore.x * zoom;
        panY = my - worldBefore.y * zoom;
        applyTransform();
      },
      { passive: false }
    );

    el.viewport.addEventListener("dragover", (ev) => ev.preventDefault());
    el.viewport.addEventListener("drop", (ev) => {
      ev.preventDefault();
      const type = ev.dataTransfer.getData("text/nanoplc-block");
      if (type) {
        const extra = {};
        const callProgram = ev.dataTransfer.getData("text/nanoplc-call-program");
        if (callProgram) {
          extra.program = callProgram;
        }
        const localVar = ev.dataTransfer.getData("text/nanoplc-local-var");
        if (localVar) {
          extra.name = localVar;
        }
        addBlock(type, screenToWorld(ev.clientX, ev.clientY), extra);
      }
    });
  }

  function payloadKey(d) {
    return JSON.stringify({
      name: d.name,
      blocks: d.blocks,
      wires: d.wires,
      variables: d.variables || [],
      layout: d.layout,
    });
  }

  function commit() {
    if (!doc) {
      return;
    }
    dirtyFromUser = true;
    const sentKey = payloadKey(doc);
    renderAll();
    vscode.postMessage({
      type: "update",
      payload: {
        schema_version: doc.schema_version,
        name: doc.name,
        blocks: doc.blocks,
        wires: doc.wires,
        variables: doc.variables || [],
        layout: doc.layout,
      },
    });
    window.__nanoplcPendingKey = sentKey;
  }

  function requestHostAction(type) {
    if (doc) {
      commit();
    }
    vscode.postMessage({ type });
  }

  if (el.btnCompile) {
    el.btnCompile.addEventListener("click", () => requestHostAction("compile"));
  }
  if (el.btnBuild) {
    el.btnBuild.classList.add("primary");
    el.btnBuild.addEventListener("click", () => requestHostAction("buildFirmware"));
  }

  function renderAll() {
    if (!doc) {
      return;
    }
    portTypes = computePortTypes(doc);
    el.title.textContent = doc.name || "FBD";
    renderPalette();
    renderBlocks();
    renderWires();
    renderProperties();
  }

  window.addEventListener("keydown", (ev) => {
    if (ev.key === "Delete" || ev.key === "Backspace") {
      if (selectedWireIndex !== null && doc) {
        deleteWire(selectedWireIndex);
        ev.preventDefault();
      }
    }
  });

  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (msg.type === "document") {
      const incoming = msg.payload;
      if (!incoming.layout) {
        incoming.layout = {};
      }
      if (!Array.isArray(incoming.variables)) {
        incoming.variables = [];
      }
      if (dirtyFromUser && window.__nanoplcPendingKey === payloadKey(incoming)) {
        dirtyFromUser = false;
        window.__nanoplcPendingKey = undefined;
        return;
      }
      dirtyFromUser = false;
      window.__nanoplcPendingKey = undefined;
      doc = incoming;
      el.parseError.classList.add("hidden");
      renderPalette();
      renderAll();
    } else if (msg.type === "ioProfile") {
      ioProfile = msg.payload || { di: [], do: [], ai: [], modules: [], source: "none" };
      if (doc) {
        renderProperties();
        renderBlocks();
      }
    } else if (msg.type === "programs") {
      projectPrograms = msg.payload || { currentProgramId: undefined, programs: [] };
      renderPalette();
      if (doc) {
        renderProperties();
        renderBlocks();
      }
    } else if (msg.type === "simLive") {
      simLive = msg.payload || { running: false, vars: {} };
      applyLiveHighlight();
    } else if (msg.type === "parseError") {
      el.parseError.textContent = msg.message;
      el.parseError.classList.remove("hidden");
    }
  });

  renderPalette();
  setupPanZoom();
  applyTransform();
})();
