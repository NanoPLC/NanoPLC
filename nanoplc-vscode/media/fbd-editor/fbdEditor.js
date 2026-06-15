/* global acquireVsCodeApi */
(function () {
  const vscode = acquireVsCodeApi();
  const catalog = window.__NANOPLC_BLOCK_CATALOG__ || [];

  const BLOCK_W = 128;
  const BLOCK_H = 56;

  /** @type {import('@nanoplc/ir-schema').FbdSource & { layout: Record<string, {x:number,y:number}> } | null} */
  let doc = null;
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
  };

  function findDef(type) {
    return catalog.find((b) => b.type === String(type).toUpperCase());
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

  function renderWires() {
    el.wires.innerHTML = "";
    if (!doc) {
      return;
    }
    doc.wires.forEach((wire, index) => {
      const from = portCenter(wire.from.block, wire.from.port, "out");
      const to = portCenter(wire.to.block, wire.to.port, "in");
      const d = wirePath(from, to);

      const hit = document.createElementNS("http://www.w3.org/2000/svg", "path");
      hit.setAttribute("d", d);
      hit.setAttribute("class", "wire-hit");
      hit.dataset.index = String(index);
      hit.style.pointerEvents = "stroke";
      // Use mousedown + stopPropagation so the canvas pan handler doesn't
      // re-render (and destroy) this element before click/dblclick fire.
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
      path.setAttribute("class", "wire-path" + (selectedWireIndex === index ? " selected" : ""));
      path.dataset.index = String(index);
      path.style.pointerEvents = "none";

      el.wires.appendChild(hit);
      el.wires.appendChild(path);
    });

    if (wireDrag && wireDrag.moved) {
      const a = wireDrag.from.kind === "out" ? wireDrag.start : wireDrag.cursor;
      const b = wireDrag.from.kind === "out" ? wireDrag.cursor : wireDrag.start;
      const preview = document.createElementNS("http://www.w3.org/2000/svg", "path");
      preview.setAttribute("d", wirePath(a, b));
      preview.setAttribute("class", "wire-path wire-preview");
      preview.style.pointerEvents = "none";
      el.wires.appendChild(preview);
    }
  }

  function blockSubtitle(block) {
    const def = findDef(block.type);
    if (block.params?.symbol) {
      return String(block.params.symbol);
    }
    if (block.params?.pt_ms !== undefined) {
      return `PT ${block.params.pt_ms} ms`;
    }
    return def?.label || block.type;
  }

  function renderBlocks() {
    el.blocks.innerHTML = "";
    if (!doc) {
      return;
    }
    for (const block of doc.blocks) {
      const def = findDef(block.type);
      const pos = doc.layout[block.id] || { x: 48, y: 48 };
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

      const sub = document.createElement("div");
      sub.className = "block-sub";
      sub.textContent = blockSubtitle(block);
      div.appendChild(sub);

      const ports = document.createElement("div");
      ports.className = "ports";
      for (const p of def?.inputs || []) {
        const pin = document.createElement("div");
        pin.className = "port port-in";
        pin.dataset.port = p;
        pin.title = p;
        pin.addEventListener("mousedown", (ev) => startWireDrag(ev, block.id, p, "in"));
        pin.addEventListener("click", (ev) => onPortClick(ev, block.id, p, "in"));
        ports.appendChild(pin);
      }
      for (const p of def?.outputs || []) {
        const pin = document.createElement("div");
        pin.className = "port port-out";
        pin.dataset.port = p;
        pin.title = p;
        pin.addEventListener("mousedown", (ev) => startWireDrag(ev, block.id, p, "out"));
        pin.addEventListener("click", (ev) => onPortClick(ev, block.id, p, "out"));
        ports.appendChild(pin);
      }
      div.appendChild(ports);

      div.addEventListener("mousedown", (ev) => {
        if (ev.button !== 0 || ev.target.classList.contains("port")) {
          return;
        }
        ev.stopPropagation();
        selectedBlockId = block.id;
        selectedWireIndex = null;
        startBlockDrag(ev, block.id);
        renderProperties();
        renderBlocks();
        renderWires();
      });

      el.blocks.appendChild(div);
    }
    highlightWirePorts();
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
    if (!selectedBlockId) {
      el.properties.innerHTML = "<p class=\"muted\">Select a block or a connection</p>";
      return;
    }
    const block = doc.blocks.find((b) => b.id === selectedBlockId);
    if (!block) {
      return;
    }
    const def = findDef(block.type);
    const idRow = document.createElement("div");
    idRow.className = "prop-row";
    idRow.innerHTML = `<label>ID</label><input readonly value="${block.id}" />`;
    el.properties.appendChild(idRow);

    for (const p of def?.params || []) {
      const row = document.createElement("div");
      row.className = "prop-row";
      const label = document.createElement("label");
      label.textContent = p.label;
      const input = document.createElement("input");
      input.type = p.type === "number" ? "number" : "text";
      input.value = block.params?.[p.key] ?? p.default ?? "";
      input.addEventListener("change", () => {
        block.params = block.params || {};
        block.params[p.key] = p.type === "number" ? Number(input.value) : input.value;
        commit();
      });
      row.appendChild(label);
      row.appendChild(input);
      el.properties.appendChild(row);
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
    const groups = { io: [], logic: [], timer: [] };
    for (const item of catalog) {
      (groups[item.category] || groups.logic).push(item);
    }
    el.palette.innerHTML = "";
    for (const [cat, title] of [
      ["io", "I/O"],
      ["logic", "Logic"],
      ["timer", "Timers"],
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
  }

  function addBlock(type, at) {
    if (!doc) {
      return;
    }
    const id = nextBlockId(type);
    const center = at || {
      x: (-panX + el.viewport.clientWidth / 2) / zoom - BLOCK_W / 2,
      y: (-panY + el.viewport.clientHeight / 2) / zoom - BLOCK_H / 2,
    };
    doc.blocks.push({ id, type: type.toUpperCase(), params: defaultParams(type) });
    doc.layout[id] = { x: Math.round(center.x), y: Math.round(center.y) };
    selectedBlockId = id;
    selectedWireIndex = null;
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
        const factor = ev.deltaY > 0 ? 0.9 : 1.1;
        zoom = Math.min(2.5, Math.max(0.35, zoom * factor));
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
        addBlock(type, screenToWorld(ev.clientX, ev.clientY));
      }
    });
  }

  function payloadKey(d) {
    return JSON.stringify({ name: d.name, blocks: d.blocks, wires: d.wires, layout: d.layout });
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
        layout: doc.layout,
      },
    });
    window.__nanoplcPendingKey = sentKey;
  }

  function renderAll() {
    if (!doc) {
      return;
    }
    el.title.textContent = doc.name || "FBD";
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
      if (dirtyFromUser && window.__nanoplcPendingKey === payloadKey(incoming)) {
        dirtyFromUser = false;
        window.__nanoplcPendingKey = undefined;
        return;
      }
      dirtyFromUser = false;
      window.__nanoplcPendingKey = undefined;
      doc = incoming;
      el.parseError.classList.add("hidden");
      renderAll();
    } else if (msg.type === "parseError") {
      el.parseError.textContent = msg.message;
      el.parseError.classList.remove("hidden");
    }
  });

  renderPalette();
  setupPanZoom();
  applyTransform();
})();
