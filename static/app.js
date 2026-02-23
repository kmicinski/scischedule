const PROTOCOL_COLORS = [
  "#1f6aa5",
  "#007f5f",
  "#7b2cbf",
  "#c44536",
  "#0f766e",
  "#3a5a40",
  "#9d4edd",
  "#00509d",
  "#2d6a4f",
  "#bc6c25",
  "#6a4c93",
  "#006d77",
  "#b5179e",
  "#355070",
  "#1982c4",
  "#8ac926",
  "#5f0f40",
  "#2b2d42",
  "#118ab2",
  "#52796f",
];

const state = {
  now: new Date(),
  monthCursor: new Date(),
  weekCursor: new Date(),
  protocols: [],
  experiments: [],
  monthView: null,
  weekView: null,
  currentTab: "month",
  selectedExperimentId: null,
  placement: null,
  pendingMove: null,
  taskContext: new Map(),
  experimentColorHues: {},
  taskNotes: {},
  activeDrag: null,
  protocolEditor: null,
};

const $ = (sel) => document.querySelector(sel);
const protocolList = $("#protocol-list");
const monthGrid = $("#month-grid");
const monthWeekdays = $("#month-weekdays");
const weekGrid = $("#week-grid");
const monthTitle = $("#month-title");
const weekTitle = $("#week-title");
const statusLine = $("#status-line");
const lockSelectedBtn = $("#lock-selected-btn");
const protocolDialog = $("#protocol-dialog");
const protocolForm = $("#protocol-form");
const protocolDialogTitle = $("#protocol-dialog-title");
const saveProtocolBtn = $("#save-protocol-btn");
const placementPanel = $("#placement-panel");
const placementTitle = $("#placement-title");
const placementCandidate = $("#placement-candidate");
const scientistNameInput = $("#scientist-name");
const adjustControls = $("#adjust-controls");
const moveSubtitle = $("#move-subtitle");
const moveReason = $("#move-reason");
const moveConfirmBtn = $("#move-confirm");
const appShell = document.querySelector(".app-shell");

init();

async function init() {
  loadTaskNotes();
  bindUi();
  await refreshAll();
}

function bindUi() {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      state.currentTab = tab.dataset.view;
      document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
      $(`#${tab.dataset.view}-view`).classList.add("active");
      updateLayoutForTab();
    });
  });

  $("#today-btn").addEventListener("click", async () => {
    state.monthCursor = new Date();
    state.weekCursor = new Date();
    await renderViews();
  });

  lockSelectedBtn.addEventListener("click", async () => {
    if (!state.selectedExperimentId) return;
    await lockExperiment(state.selectedExperimentId);
  });

  $("#month-prev").addEventListener("click", async () => {
    state.monthCursor.setMonth(state.monthCursor.getMonth() - 1);
    await renderMonth();
  });

  $("#month-next").addEventListener("click", async () => {
    state.monthCursor.setMonth(state.monthCursor.getMonth() + 1);
    await renderMonth();
  });

  $("#week-prev").addEventListener("click", async () => {
    state.weekCursor.setDate(state.weekCursor.getDate() - 7);
    await renderWeek();
  });

  $("#week-next").addEventListener("click", async () => {
    state.weekCursor.setDate(state.weekCursor.getDate() + 7);
    await renderWeek();
  });

  $("#placement-create").addEventListener("click", async () => {
    await finalizePlacement();
  });

  $("#placement-cancel").addEventListener("click", () => {
    clearPlacement();
    drawMonthGrid();
  });

  $("#move-confirm").addEventListener("click", async () => {
    await commitPendingMove();
  });

  $("#move-cancel").addEventListener("click", () => {
    clearPendingMove();
  });

  document.addEventListener("keydown", async (e) => {
    const target = e.target;
    const inEditable =
      target &&
      (target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable ||
        target.tagName === "SELECT");
    if (inEditable) return;
    if (state.pendingMove) {
      if (e.key === "Enter") {
        e.preventDefault();
        await commitPendingMove();
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        clearPendingMove();
        return;
      }
    }

    if (state.currentTab !== "week") return;

    if (e.key === "ArrowLeft") {
      e.preventDefault();
      state.weekCursor.setDate(state.weekCursor.getDate() - 7);
      await renderWeek();
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      state.weekCursor.setDate(state.weekCursor.getDate() + 7);
      await renderWeek();
    }
  });

  initScientistProfile();
  document.addEventListener("dragend", clearActiveDrag);

  placementCandidate.addEventListener("dragstart", (e) => {
    if (!state.placement?.protocolId) return;
    setDragPayload(e, {
      kind: "protocol",
      protocolId: state.placement.protocolId,
      previewAnchor: true,
    });
  });

  const openNewProtocol = () => {
    openProtocolDialogForCreate();
  };
  $("#new-protocol-btn").addEventListener("click", openNewProtocol);
  $("#new-protocol-btn-top").addEventListener("click", openNewProtocol);
  $("#cancel-protocol").addEventListener("click", () => protocolDialog.close());
  $("#add-step").addEventListener("click", () => addStepCard());

  protocolForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const saved = await saveProtocolFromDialog();
    if (saved) {
      protocolDialog.close();
    }
  });

  protocolDialog.addEventListener("close", () => {
    state.protocolEditor = null;
    syncProtocolDialogChrome();
  });

  updateLayoutForTab();
}

function updateLayoutForTab() {
  if (!appShell) return;
  appShell.classList.toggle("week-focus", state.currentTab === "week");
}

/* ── Protocol Dialog ────────────────────────────────────────────── */

function resetProtocolDialog() {
  const container = $("#steps-container");
  container.innerHTML = "";
  protocolForm.reset();
  addStepCard();
  syncProtocolDialogChrome();
  renderDagPreview();
}

function syncProtocolDialogChrome() {
  const isEdit = state.protocolEditor?.mode === "edit";
  if (protocolDialogTitle) {
    protocolDialogTitle.textContent = isEdit ? "Edit Protocol" : "Create Protocol";
  }
  if (saveProtocolBtn) {
    saveProtocolBtn.textContent = isEdit ? "Save Changes" : "Save Protocol";
  }
}

function openProtocolDialogForCreate() {
  state.protocolEditor = { mode: "create", protocolId: null };
  resetProtocolDialog();
  protocolDialog.showModal();
}

function openProtocolDialogForEdit(protocolId) {
  const protocol = state.protocols.find((p) => p.id === protocolId);
  if (!protocol) {
    showStatus("Protocol not found.", true);
    return;
  }

  state.protocolEditor = { mode: "edit", protocolId };
  resetProtocolDialog();

  protocolForm.elements.name.value = protocol.name || "";
  protocolForm.elements.description.value = protocol.description || "";

  const container = $("#steps-container");
  container.innerHTML = "";
  const steps = Array.isArray(protocol.steps) && protocol.steps.length > 0 ? protocol.steps : [];
  steps.forEach(() => addStepCard());

  const cards = Array.from(container.querySelectorAll(".step-card"));
  const indexByStepId = new Map(steps.map((step, idx) => [step.id, idx]));

  steps.forEach((step, idx) => {
    const card = cards[idx];
    if (!card) return;
    card.querySelector(".step-name").value = step.name || "";
    card.querySelector(".step-details").value = step.details || "";
    card.querySelector(".step-offset").value = String(step.default_offset_days ?? 0);

    const pids = parentStepIds(step);
    const parentIdxs = pids
      .map((pid) => indexByStepId.get(pid))
      .filter((idx) => Number.isInteger(idx));
    card.dataset.parentIndexes = JSON.stringify(parentIdxs);
  });

  refreshAllStepCards();
  protocolDialog.showModal();
}

function addStepCard() {
  const container = $("#steps-container");
  container.insertAdjacentHTML(
    "beforeend",
    `<div class="step-card" data-parent-indexes="[]">
      <div class="step-card-header">
        <span class="step-badge">1</span>
        <input class="step-name" placeholder="Step name" required />
        <button type="button" class="step-delete-btn" title="Remove step">\u00d7</button>
      </div>
      <input class="step-details" placeholder="Details / instructions (optional)" />
      <div class="step-card-footer">
        <div class="step-deps">
          <span class="step-deps-label">Depends on</span>
          <div class="step-deps-chips"></div>
          <select class="step-dep-add">
            <option value="">+ dependency</option>
          </select>
        </div>
        <label class="step-offset-field">
          <span>Offset</span>
          <input class="step-offset" type="number" value="0" min="0" />
          <span>days</span>
        </label>
      </div>
    </div>`,
  );
  const insertedCard = container.lastElementChild;

  insertedCard.querySelector(".step-delete-btn").addEventListener("click", () => {
    removeStepCard(insertedCard);
  });

  insertedCard.querySelector(".step-dep-add").addEventListener("change", function () {
    const val = this.value;
    if (val === "") return;
    const idx = parseInt(val, 10);
    const current = JSON.parse(insertedCard.dataset.parentIndexes || "[]");
    if (!current.includes(idx)) {
      current.push(idx);
      insertedCard.dataset.parentIndexes = JSON.stringify(current);
    }
    this.value = "";
    refreshAllStepCards();
  });

  insertedCard.querySelector(".step-name").addEventListener("input", () => {
    refreshAllStepCards();
  });

  insertedCard.querySelector(".step-offset").addEventListener("input", () => {
    renderDagPreview();
  });

  refreshAllStepCards();
}

function removeStepCard(card) {
  const container = $("#steps-container");
  const cards = Array.from(container.querySelectorAll(".step-card"));
  const removedIndex = cards.indexOf(card);
  if (removedIndex === -1) return;

  if (cards.length <= 1) {
    showStatus("Protocol must have at least one step.", true);
    return;
  }

  cards.forEach((c, i) => {
    if (i === removedIndex) return;
    let parents = JSON.parse(c.dataset.parentIndexes || "[]");
    parents = parents.filter((p) => p !== removedIndex);
    parents = parents.map((p) => (p > removedIndex ? p - 1 : p));
    c.dataset.parentIndexes = JSON.stringify(parents);
  });

  card.remove();
  refreshAllStepCards();
}

function refreshAllStepCards() {
  const cards = Array.from(document.querySelectorAll("#steps-container .step-card"));

  cards.forEach((card, idx) => {
    const badge = card.querySelector(".step-badge");
    if (badge) badge.textContent = String(idx + 1);

    renderDependencyChips(card, cards, idx);
    refreshDepAddOptions(card, cards, idx);
  });

  renderDagPreview();
}

function renderDependencyChips(card, cards, myIndex) {
  const chipsContainer = card.querySelector(".step-deps-chips");
  if (!chipsContainer) return;
  chipsContainer.innerHTML = "";

  const parentIndexes = JSON.parse(card.dataset.parentIndexes || "[]");

  if (parentIndexes.length === 0) {
    const rootChip = document.createElement("span");
    rootChip.className = "dep-chip root-chip";
    rootChip.textContent = "root";
    chipsContainer.appendChild(rootChip);
    return;
  }

  for (const pi of parentIndexes) {
    if (pi < 0 || pi >= cards.length || pi === myIndex) continue;
    const name = cards[pi].querySelector(".step-name").value || `Step ${pi + 1}`;
    const chip = document.createElement("span");
    chip.className = "dep-chip";

    const label = document.createElement("span");
    label.textContent = name;
    chip.appendChild(label);

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "dep-chip-remove";
    removeBtn.textContent = "\u00d7";
    removeBtn.addEventListener("click", () => {
      let current = JSON.parse(card.dataset.parentIndexes || "[]");
      current = current.filter((p) => p !== pi);
      card.dataset.parentIndexes = JSON.stringify(current);
      refreshAllStepCards();
    });
    chip.appendChild(removeBtn);
    chipsContainer.appendChild(chip);
  }
}

function refreshDepAddOptions(card, cards, myIndex) {
  const sel = card.querySelector(".step-dep-add");
  if (!sel) return;
  const currentParents = JSON.parse(card.dataset.parentIndexes || "[]");

  sel.innerHTML = '<option value="">+ dependency</option>';
  cards.forEach((c, jdx) => {
    if (jdx === myIndex) return;
    if (currentParents.includes(jdx)) return;
    const name = c.querySelector(".step-name").value || `Step ${jdx + 1}`;
    sel.insertAdjacentHTML("beforeend", `<option value="${jdx}">${escapeHtml(name)}</option>`);
  });

  sel.style.display = sel.options.length <= 1 ? "none" : "";
}

function renderDagPreview() {
  const canvas = document.getElementById("dag-canvas");
  if (!canvas) return;

  const cards = Array.from(document.querySelectorAll("#steps-container .step-card"));
  if (cards.length === 0) {
    canvas.innerHTML = '<div class="dag-empty">Add steps to see the dependency graph</div>';
    return;
  }

  const names = cards.map(
    (c, i) => c.querySelector(".step-name").value || `Step ${i + 1}`,
  );
  const parentIndexes = cards.map((c) =>
    JSON.parse(c.dataset.parentIndexes || "[]"),
  );

  const depths = new Array(cards.length).fill(0);
  const visited = new Set();

  function computeDepth(i) {
    if (visited.has(i)) return depths[i];
    visited.add(i);
    for (const pi of parentIndexes[i]) {
      if (pi >= 0 && pi < cards.length && pi !== i) {
        depths[i] = Math.max(depths[i], computeDepth(pi) + 1);
      }
    }
    return depths[i];
  }

  for (let i = 0; i < cards.length; i++) computeDepth(i);

  const maxDepth = Math.max(...depths, 0);
  const layers = Array.from({ length: maxDepth + 1 }, () => []);
  for (let i = 0; i < cards.length; i++) {
    layers[depths[i]].push(i);
  }

  let html = '<div class="dag-layers">';
  for (let d = 0; d <= maxDepth; d++) {
    if (d > 0) html += '<div class="dag-arrow-col">\u2192</div>';
    html += '<div class="dag-layer">';
    for (const i of layers[d]) {
      html += `<div class="dag-node"><span class="dag-node-num">${i + 1}</span><span class="dag-node-name">${escapeHtml(names[i])}</span></div>`;
    }
    html += "</div>";
  }
  html += "</div>";

  canvas.innerHTML = html;
}

function protocolFormRequestPayload() {
  const name = protocolForm.elements.name.value;
  const description = protocolForm.elements.description.value;

  const cards = Array.from(document.querySelectorAll("#steps-container .step-card"));
  const steps = cards.map((card) => ({
    name: card.querySelector(".step-name").value,
    details: card.querySelector(".step-details").value,
    parent_step_indexes: JSON.parse(card.dataset.parentIndexes || "[]"),
    default_offset_days: parseInt(card.querySelector(".step-offset").value || "0", 10),
  }));

  return { name, description, steps };
}

async function saveProtocolFromDialog() {
  const isEdit = state.protocolEditor?.mode === "edit" && state.protocolEditor.protocolId;
  const payload = protocolFormRequestPayload();
  const url = isEdit ? `/api/protocols/${state.protocolEditor.protocolId}` : "/api/protocols";
  const method = isEdit ? "PATCH" : "POST";
  const saved = await api(url, {
    method,
    body: JSON.stringify(payload),
  });

  if (!saved.id) {
    showStatus(saved.error || `Failed to ${isEdit ? "update" : "create"} protocol`, true);
    return false;
  }

  showStatus(isEdit ? "Protocol updated." : "Protocol created.");
  await refreshAll();
  return true;
}

/* ── Data refresh ───────────────────────────────────────────────── */

async function refreshAll() {
  state.protocols = await api("/api/protocols");
  state.experiments = await api("/api/experiments");
  if (!Array.isArray(state.protocols)) state.protocols = [];
  if (!Array.isArray(state.experiments)) state.experiments = [];

  ensureExperimentColors();
  rebuildTaskContext();
  renderProtocols();
  renderExperiments();
  updateLockButton();
  updatePlacementPanel();
  updateMovePanel();
  await renderViews();
}

function rebuildTaskContext() {
  state.taskContext.clear();

  for (const exp of state.experiments) {
    const protocol = state.protocols.find((p) => p.id === exp.protocol_id);
    const steps = protocol?.steps || [];
    const stepById = new Map(steps.map((s) => [s.id, s]));
    const childrenById = new Map();

    for (const step of steps) {
      for (const parentId of parentStepIds(step)) {
        const arr = childrenById.get(parentId) || [];
        arr.push(step.id);
        childrenById.set(parentId, arr);
      }
    }

    const taskByStep = new Map(exp.tasks.map((t) => [t.step_id, t]));

    for (const task of exp.tasks) {
      const step = stepById.get(task.step_id);
      const parentDates = parentStepIds(step)
        .map((parentId) => taskByStep.get(parentId)?.date)
        .filter(Boolean)
        .sort();
      const nextDates = (childrenById.get(task.step_id) || [])
        .map((sid) => taskByStep.get(sid)?.date)
        .filter(Boolean)
        .sort();

      state.taskContext.set(task.id, {
        experimentId: exp.id,
        protocolId: exp.protocol_id,
        protocolName: exp.protocol_name,
        task,
        parentDate: parentDates[parentDates.length - 1] || null,
        nextDates,
      });
    }
  }
}

/* ── Rendering: sidebar ─────────────────────────────────────────── */

async function renderViews() {
  await Promise.all([renderMonth(), renderWeek()]);
}

function renderProtocols() {
  protocolList.innerHTML = "";
  for (const p of state.protocols) {
    const li = document.createElement("li");
    li.className = "protocol-item";
    li.draggable = true;
    li.dataset.protocolId = p.id;
    li.style.borderLeft = `4px solid ${protocolColor(p.id)}`;
    li.innerHTML = `<strong>${escapeHtml(p.name)}</strong><br/><small>${escapeHtml(p.description || "")}</small>`;

    li.addEventListener("dragstart", (e) => {
      setDragPayload(e, {
        kind: "protocol",
        protocolId: p.id,
        previewAnchor: false,
      });
    });

    li.addEventListener("click", () => {
      openProtocolDialogForEdit(p.id);
    });

    protocolList.appendChild(li);
  }
}

function renderExperiments() {
  const list = document.getElementById("experiment-list");
  if (!list) return;
  list.innerHTML = "";

  const sorted = [...state.experiments].sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));
  for (const exp of sorted) {
    const li = document.createElement("li");
    li.className = "experiment-item";
    if (state.selectedExperimentId === exp.id) li.classList.add("selected");

    const statusClass = (exp.status || "Draft").toLowerCase();
    const taskCount = (exp.tasks || []).length;
    const deviationCount = (exp.tasks || []).filter((t) => t.deviation).length;
    const metaParts = [`${taskCount} tasks`];
    if (deviationCount > 0) metaParts.push(`${deviationCount} deviated`);

    li.innerHTML = `
      <div class="experiment-item-header">
        <span class="experiment-color-dot" style="background:${experimentColor(exp.id)}"></span>
        <span class="experiment-item-name">${escapeHtml(exp.protocol_name)}</span>
        <span class="experiment-status-badge ${statusClass}">${escapeHtml(exp.status)}</span>
      </div>
      <div class="experiment-item-meta">${escapeHtml(metaParts.join(" · "))} · ${escapeHtml(exp.created_by)}</div>
    `;

    li.addEventListener("click", () => {
      if (state.selectedExperimentId === exp.id) {
        selectExperiment(null);
      } else {
        selectExperiment(exp.id);
      }
    });

    list.appendChild(li);
  }
}

/* ── Rendering: month view ──────────────────────────────────────── */

async function renderMonth() {
  const year = state.monthCursor.getFullYear();
  const month = state.monthCursor.getMonth() + 1;
  state.monthView = await api(`/api/views/month?year=${year}&month=${month}`);
  monthTitle.textContent = `${state.monthCursor.toLocaleString(undefined, { month: "long" })} ${year}`;
  renderWeekdayHeader();
  drawMonthGrid();
}

function renderWeekdayHeader() {
  monthWeekdays.innerHTML = "";
  ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].forEach((w) => {
    const d = document.createElement("div");
    d.className = "weekday";
    d.textContent = w;
    monthWeekdays.appendChild(d);
  });
}

function drawMonthGrid() {
  if (!state.monthView || !Array.isArray(state.monthView.cells)) return;

  clearHoverFocus();
  monthGrid.innerHTML = "";

  const year = state.monthCursor.getFullYear();
  const month = state.monthCursor.getMonth() + 1;
  const first = new Date(year, month - 1, 1);
  const leadingEmpty = (first.getDay() + 6) % 7;
  for (let i = 0; i < leadingEmpty; i++) {
    const spacer = document.createElement("div");
    monthGrid.appendChild(spacer);
  }

  const previewByDate = buildPlacementTasksByDate();
  const todayISO = dateToISO(new Date());

  for (const cell of state.monthView.cells) {
    const d = new Date(cell.date + "T00:00:00");
    const div = document.createElement("div");
    div.className = "month-cell";
    div.dataset.date = cell.date;
    if (cell.date === todayISO) div.classList.add("today");
    const dow = d.getDay();
    if (dow === 0 || dow === 6) div.classList.add("weekend");
    div.innerHTML = `<div class="day-number">${d.getDate()}</div>`;

    if (state.pendingMove?.toDate === cell.date) {
      div.classList.add("adjust-target");
    }

    drawTaskRows(div, cell, previewByDate.get(cell.date) || []);

    div.addEventListener("click", () => {
      if (state.placement) {
        state.placement.anchorDate = cell.date;
        updatePlacementPanel();
        drawMonthGrid();
      }
    });

    // Dragover: lightweight — no stageMove, no DOM rebuild.
    // Just highlight the cell and check constraints.
    div.addEventListener("dragover", (e) => {
      const drag = readDragPayload(e.dataTransfer);
      const isProtocolDrop = Boolean(
        drag?.kind === "protocol" && (drag.protocolId || state.placement?.protocolId),
      );
      const isTaskDrop = Boolean(drag?.kind === "task" && drag.taskId);

      div.classList.remove("adjust-invalid");

      if (isProtocolDrop) {
        e.preventDefault();
        div.classList.add("drag-over");
        const nextProtocolId = drag.protocolId || state.placement?.protocolId;
        const needsUpdate =
          !state.placement ||
          state.placement.protocolId !== nextProtocolId ||
          state.placement.anchorDate !== cell.date;
        if (needsUpdate) {
          beginPlacement(nextProtocolId, cell.date);
          drawMonthGrid();
        }
      } else if (isTaskDrop) {
        // Check constraint without mutating state
        const ctx = state.taskContext.get(drag.taskId);
        if (ctx?.parentDate && cell.date < ctx.parentDate) {
          div.classList.add("adjust-invalid");
        } else {
          e.preventDefault();
          div.classList.add("drag-over");
        }
      } else {
        div.classList.remove("drag-over");
      }
    });

    div.addEventListener("dragleave", () => {
      div.classList.remove("drag-over");
      div.classList.remove("adjust-invalid");
    });

    // Drop: stage the move here (single repaint)
    div.addEventListener("drop", (e) => {
      e.preventDefault();
      div.classList.remove("drag-over");
      div.classList.remove("adjust-invalid");
      const drag = readDragPayload(e.dataTransfer);

      if (drag?.kind === "protocol") {
        beginPlacement(drag.protocolId || state.placement?.protocolId, cell.date);
        drawMonthGrid();
      } else if (drag?.kind === "task" && drag.taskId) {
        stageMove(
          resolveTaskExperimentId(drag.taskId, drag.experimentId),
          drag.taskId,
          cell.date,
        );
      }
      clearActiveDrag();
    });

    monthGrid.appendChild(div);
  }
}

/**
 * Draw task rows inside a month cell.
 *
 * Model: always render REAL tasks from cell.tasks at their actual position.
 * When a pending move exists, tasks that will shift get a "moving-away" badge,
 * and ghost copies appear at projected destination cells.
 */
function drawTaskRows(cellEl, cell, previews) {
  const realTasks = Array.isArray(cell.tasks) ? cell.tasks : [];
  const pending = state.pendingMove;
  const shiftedStepIds = pending ? new Set(pending.shiftedStepIds || []) : null;
  const maxRows = 10;
  const rows = [];

  // 1. Real tasks — always shown at their actual stored position
  const sorted = realTasks.slice().sort((a, b) => (a.day_priority ?? 0) - (b.day_priority ?? 0));
  for (const task of sorted) {
    const ctx = state.taskContext.get(task.id);
    if (!ctx) continue;

    const isMovingAway =
      pending &&
      ctx.experimentId === pending.experimentId &&
      shiftedStepIds.has(task.step_id);

    rows.push({
      kind: "task",
      task,
      text: `${ctx.protocolName}: ${task.step_name}`,
      experimentId: ctx.experimentId,
      parentDate: ctx.parentDate,
      nextDates: ctx.nextDates,
      deviation: Boolean(task.deviation),
      movingAway: isMovingAway,
    });
  }

  // 2. Ghost rows — tasks projected to arrive at this cell's date
  if (pending && shiftedStepIds) {
    const exp = state.experiments.find((e) => e.id === pending.experimentId);
    if (exp) {
      for (const task of exp.tasks) {
        if (!shiftedStepIds.has(task.step_id)) continue;
        const projectedDate = addDays(task.date, pending.deltaDays);
        if (projectedDate !== cell.date) continue;
        // If task is already on this date, it's shown as a real row (with moving-away badge
        // if it will shift to a different date, or unchanged if delta is 0). Skip ghost.
        if (task.date === cell.date) continue;
        const ctx = state.taskContext.get(task.id);
        if (!ctx) continue;
        rows.push({
          kind: "ghost",
          task: { ...task, date: projectedDate },
          text: `${ctx.protocolName}: ${task.step_name}`,
          experimentId: ctx.experimentId,
        });
      }
    }
  }

  // 3. Placement previews
  previews.forEach((preview) => {
    const protocol = state.protocols.find((p) => p.id === state.placement?.protocolId);
    rows.push({
      kind: "preview",
      text: `${protocol?.name || "Preview"}: ${preview.label}`,
      protocolId: state.placement?.protocolId,
      isRoot: preview.isRoot,
    });
  });

  const visibleRows = rows.slice(0, maxRows);

  visibleRows.forEach((row) => {
    const div = document.createElement("div");
    const classes = ["task-row"];
    if (row.kind === "preview") classes.push("preview");
    if (row.isRoot) classes.push("preview-root");
    if (row.deviation) classes.push("deviation");
    if (row.movingAway) classes.push("moving-away");
    if (row.kind === "ghost") classes.push("ghost");
    div.className = classes.join(" ");

    if (row.kind === "task" && state.selectedExperimentId === row.experimentId) {
      div.classList.add("selected");
    }

    if (row.kind === "task") {
      div.dataset.experimentId = row.experimentId;
      div.dataset.taskId = row.task.id;
    }

    const color =
      row.kind === "task" || row.kind === "ghost"
        ? experimentColor(row.experimentId)
        : protocolColor(row.protocolId);
    div.style.setProperty("--proto-color", color);

    if (row.kind === "ghost") {
      div.innerHTML = `
        <div class="task-row-main">
          <span class="ghost-badge">candidate</span>
          <div class="task-row-text">${escapeHtml(row.text)}</div>
        </div>
      `;
    } else {
      div.innerHTML = `
        <div class="task-row-main">
          ${row.kind === "task" ? '<span class="drag-handle" title="Drag to move">::</span>' : ""}
          <div class="task-row-text">${escapeHtml(row.text)}</div>
          ${row.movingAway ? '<span class="moving-away-badge" title="Will shift when confirmed">&rarr;</span>' : ""}
        </div>
      `;
    }

    // Real tasks: draggable (unless moving away in a staged move)
    if (row.kind === "task" && !row.movingAway) {
      div.draggable = true;
      div.addEventListener("dragstart", (e) => {
        // Clear any existing pending move when starting a new drag
        if (state.pendingMove) {
          state.pendingMove = null;
          updateMovePanel();
        }
        div.classList.add("dragging");
        document.body.classList.add("drag-task-active");
        setDragPayload(e, {
          kind: "task",
          taskId: row.task.id,
          experimentId: row.experimentId,
        });
        showDragConstraintZones(row.task.id);
      });
      div.addEventListener("dragend", () => {
        div.classList.remove("dragging");
        document.body.classList.remove("drag-task-active");
        clearDragConstraintZones();
        monthGrid
          .querySelectorAll(".month-cell.adjust-invalid")
          .forEach((c) => c.classList.remove("adjust-invalid"));
        clearActiveDrag();
      });

      div.addEventListener("click", (e) => {
        e.stopPropagation();
        selectExperiment(row.experimentId);
      });

      div.addEventListener("mouseenter", () => {
        if (!state.pendingMove) {
          applyHoverFocus(row.experimentId, row.task.id, row.parentDate, row.nextDates || []);
        }
      });

      div.addEventListener("mouseleave", () => {
        if (!state.pendingMove) {
          clearHoverFocus();
        }
      });
    }

    if (row.kind === "preview" && row.isRoot) {
      div.draggable = true;
      div.addEventListener("dragstart", (e) => {
        setDragPayload(e, {
          kind: "protocol",
          protocolId: state.placement.protocolId,
          previewAnchor: true,
        });
      });
    }

    cellEl.appendChild(div);
  });

  if (rows.length > maxRows) {
    const more = document.createElement("div");
    more.className = "day-rollup";
    more.textContent = `+${rows.length - maxRows} more`;
    cellEl.appendChild(more);
  }
}

/* ── Hover focus (dependency chain highlight) ───────────────────── */

function applyHoverFocus(experimentId, taskId, parentDate, nextDates) {
  clearHoverFocus();
  monthGrid.classList.add("hovering");
  const hoveredTask = state.taskContext.get(taskId)?.task || null;

  document.querySelectorAll(".task-row[data-experiment-id]").forEach((row) => {
    if (row.dataset.experimentId === experimentId) {
      row.classList.add("focused");
    }
  });

  document.querySelectorAll(".month-cell").forEach((cell) => {
    if (!cell.querySelector(`.task-row[data-experiment-id="${experimentId}"]`)) {
      cell.classList.add("muted");
    }
  });

  if (parentDate) {
    highlightRange(parentDate, state.taskContext.get(taskId)?.task.date || parentDate, "range-back");
  }

  (nextDates || []).forEach((d) => {
    highlightRange(state.taskContext.get(taskId)?.task.date || d, d, "range-forward");
  });

  const currDate = hoveredTask?.date;
  if (currDate) {
    const cell = document.querySelector(`.month-cell[data-date="${currDate}"]`);
    if (cell) cell.classList.add("range-current");
  }

}

function clearHoverFocus() {
  monthGrid.classList.remove("hovering");
  document.querySelectorAll(".task-row.focused").forEach((row) => row.classList.remove("focused"));
  document.querySelectorAll(".month-cell.muted").forEach((cell) => cell.classList.remove("muted"));
  document
    .querySelectorAll(
      ".month-cell.range-back, .month-cell.range-forward, .month-cell.range-current",
    )
    .forEach((cell) => {
      cell.classList.remove("range-back", "range-forward", "range-current");
    });
}

/* ── Drag constraint zone highlighting ──────────────────────────── */

function showDragConstraintZones(taskId) {
  clearDragConstraintZones();
  const ctx = state.taskContext.get(taskId);
  if (!ctx) return;
  const parentDate = ctx.parentDate;
  document.querySelectorAll(".month-cell").forEach((cell) => {
    const date = cell.dataset.date;
    if (!date) return;
    if (parentDate && date < parentDate) {
      cell.classList.add("drag-invalid-zone");
    } else {
      cell.classList.add("drag-valid-zone");
    }
  });

  // Highlight downstream tasks that will also shift
  const shiftedStepIds = computeShiftedStepIds(ctx.experimentId, taskId);
  shiftedStepIds.delete(ctx.task.step_id);
  if (shiftedStepIds.size > 0) {
    document.querySelectorAll(".task-row[data-task-id]").forEach((row) => {
      const rowCtx = state.taskContext.get(row.dataset.taskId);
      if (
        rowCtx &&
        rowCtx.experimentId === ctx.experimentId &&
        shiftedStepIds.has(rowCtx.task.step_id)
      ) {
        row.classList.add("downstream-impact");
      }
    });
  }
}

function clearDragConstraintZones() {
  document
    .querySelectorAll(".month-cell.drag-valid-zone, .month-cell.drag-invalid-zone")
    .forEach((c) => {
      c.classList.remove("drag-valid-zone", "drag-invalid-zone");
    });
  document
    .querySelectorAll(".task-row.downstream-impact")
    .forEach((r) => r.classList.remove("downstream-impact"));
}

function highlightRange(a, b, klass) {
  const start = a <= b ? a : b;
  const end = a <= b ? b : a;
  document.querySelectorAll(".month-cell").forEach((cell) => {
    const date = cell.dataset.date;
    if (!date) return;
    if (date >= start && date <= end) {
      cell.classList.add(klass);
    }
  });
}

/* ── Rendering: week view ───────────────────────────────────────── */

async function renderWeek(options = {}) {
  const { skipFetch = false } = options;
  if (!skipFetch) {
    const d = state.weekCursor;
    const year = d.getFullYear();
    const month = d.getMonth() + 1;
    const day = d.getDate();
    state.weekView = await api(`/api/views/week?year=${year}&month=${month}&day=${day}`);
  }
  if (!state.weekView) return;

  const weekView = state.pendingMove
    ? buildWeekPreviewView(state.weekView.week_start)
    : state.weekView;
  const start = new Date(weekView.week_start);
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  weekTitle.textContent = `${start.toLocaleDateString()} - ${end.toLocaleDateString()}`;

  const todayISO = dateToISO(new Date());
  weekGrid.innerHTML = "";
  weekGrid.classList.toggle("has-selection", Boolean(state.selectedExperimentId));

  for (const wd of weekView.days) {
    const wrap = document.createElement("section");
    wrap.className = "week-day";
    wrap.dataset.date = wd.date;

    const d = new Date(wd.date + "T00:00:00");
    const dow = d.getDay();
    if (wd.date === todayISO) wrap.classList.add("today");
    if (dow === 0 || dow === 6) wrap.classList.add("weekend");

    // Dragover: lightweight, no stageMove
    wrap.addEventListener("dragover", (e) => {
      const drag = readDragPayload(e.dataTransfer);
      if (drag?.kind === "task" && drag.taskId) {
        const ctx = state.taskContext.get(drag.taskId);
        if (ctx?.parentDate && wd.date < ctx.parentDate) {
          // Invalid drop target
        } else {
          e.preventDefault();
          wrap.classList.add("drag-over");
        }
      }
    });

    wrap.addEventListener("dragleave", () => {
      wrap.classList.remove("drag-over");
    });

    // Drop: stage move here
    wrap.addEventListener("drop", (e) => {
      e.preventDefault();
      wrap.classList.remove("drag-over");
      const drag = readDragPayload(e.dataTransfer);
      if (drag?.kind === "task" && drag.taskId) {
        stageMove(
          resolveTaskExperimentId(drag.taskId, drag.experimentId),
          drag.taskId,
          wd.date,
        );
      }
      clearActiveDrag();
    });

    renderWeekDayContent(wrap, wd);
    weekGrid.appendChild(wrap);
  }
}

function renderWeekDayContent(wrap, wd) {
  const tasks = wd.tasks || [];
  const d = new Date(wd.date + "T00:00:00");
  const taskCount = tasks.length;

  // Header with weekday, date, and task count
  const header = document.createElement("div");
  header.className = "week-day-header";
  header.innerHTML = `<span class="week-day-label">${d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}</span>${taskCount > 0 ? `<span class="week-day-count">${taskCount}</span>` : ""}`;
  wrap.appendChild(header);

  // Task container (also serves as drop target for empty days)
  const container = document.createElement("div");
  container.className = "week-day-tasks";
  wrap.appendChild(container);

  if (tasks.length === 0) {
    const empty = document.createElement("div");
    empty.className = "week-day-empty";
    empty.textContent = "No tasks";
    container.appendChild(empty);
    return;
  }

  const sorted = tasks.slice().sort((a, b) => (a.day_priority ?? 0) - (b.day_priority ?? 0));
  sorted.forEach((task, index) => {
    container.appendChild(buildWeekTaskCard(task, index));
  });
}

function buildWeekTaskCard(task, index) {
  const card = document.createElement("div");
  const ctx = state.taskContext.get(task.id);
  const expId = ctx?.experimentId || "";
  const shifted = isTaskShifted(task.id);
  const isSelected = state.selectedExperimentId === expId;

  const classes = ["week-task"];
  if (isSelected) classes.push("exp-selected");
  if (task.deviation) classes.push("deviation");
  if (shifted) classes.push("ghost");
  card.className = classes.join(" ");
  card.style.borderLeftColor = experimentColor(expId);
  card.draggable = !shifted;
  card.dataset.taskId = task.id;
  card.dataset.experimentId = expId;
  card.dataset.date = task.date;

  card.addEventListener("dragstart", (e) => {
    if (state.pendingMove) {
      state.pendingMove = null;
      updateMovePanel();
    }
    setDragPayload(e, {
      kind: "task",
      taskId: task.id,
      experimentId: expId,
    });
  });

  card.addEventListener("dragend", () => {
    clearActiveDrag();
  });

  card.addEventListener("click", () => selectExperiment(expId));

  // Intra-day reorder: dragover/drop on card
  card.addEventListener("dragover", (e) => {
    if (state.pendingMove) return;
    const drag = readDragPayload(e.dataTransfer);
    const draggingTaskId = drag?.kind === "task" ? drag.taskId : "";
    const draggingExperimentId =
      drag?.kind === "task" ? resolveTaskExperimentId(draggingTaskId, drag.experimentId) : "";
    const draggingCtx = state.taskContext.get(draggingTaskId);
    if (!draggingTaskId || !draggingCtx) return;
    const sameDay = draggingCtx.task.date === task.date;
    const sameExperiment = draggingExperimentId === expId;
    if (!sameDay || !sameExperiment) return;
    e.preventDefault();
    card.classList.add(e.offsetY < card.clientHeight / 2 ? "drop-before" : "drop-after");
  });

  card.addEventListener("dragleave", () => card.classList.remove("drop-before", "drop-after"));

  card.addEventListener("drop", async (e) => {
    if (state.pendingMove) return;
    e.preventDefault();
    card.classList.remove("drop-before", "drop-after");
    const drag = readDragPayload(e.dataTransfer);
    const draggingTaskId = drag?.kind === "task" ? drag.taskId : "";
    const draggingExperimentId =
      drag?.kind === "task" ? resolveTaskExperimentId(draggingTaskId, drag.experimentId) : "";
    if (!draggingTaskId || !draggingExperimentId || draggingTaskId === task.id) return;
    const draggingCtx = state.taskContext.get(draggingTaskId);
    if (!draggingCtx) return;
    const sameDay = draggingCtx.task.date === task.date;
    const sameExperiment = draggingExperimentId === expId;
    if (!sameDay || !sameExperiment) return;

    const insertBefore = e.offsetY < card.clientHeight / 2;
    const nextPriority = insertBefore ? task.day_priority - 1 : task.day_priority + 1;
    await reorderTask(expId, draggingTaskId, nextPriority);
    clearActiveDrag();
  });

  // Build card content
  const protocolName = ctx?.protocolName || "Experiment";
  const stepName = task.step_name || "";
  const taskNote = noteForTask(task.id);

  let statusHtml;
  if (shifted) {
    statusHtml = '<span class="ghost-badge">candidate</span>';
  } else if (task.deviation) {
    const reason = task.deviation.reason || "Deviated";
    statusHtml = `<span class="week-task-status deviation">${escapeHtml(reason)}</span>`;
  } else {
    statusHtml = '<span class="week-task-status on-protocol">On protocol</span>';
  }

  card.innerHTML = `
    <div class="week-task-left">
      ${!shifted ? '<span class="week-drag-handle" title="Drag to reorder">&#8942;&#8942;</span>' : ""}
      <span class="week-task-priority">${index + 1}</span>
    </div>
    <div class="week-task-body">
      <div class="week-task-protocol">${escapeHtml(protocolName)}</div>
      <div class="week-task-step">${escapeHtml(stepName)}</div>
      <div class="week-task-status-line">${statusHtml}</div>
    </div>
    <div class="week-task-actions">
      ${!shifted ? '<button type="button" class="week-note-btn" title="Add or edit task note">Note</button>' : ""}
    </div>
    ${taskNote ? `<div class="week-note">${escapeHtml(taskNote)}</div>` : ""}
  `;

  if (!shifted) {
    const noteBtn = card.querySelector(".week-note-btn");
    if (noteBtn) {
      noteBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        editTaskNote(task.id, task.step_name);
      });
    }
  }

  return card;
}

/* ── Selection ──────────────────────────────────────────────────── */

function selectExperiment(experimentId) {
  state.selectedExperimentId = experimentId || null;
  updateLockButton();
  renderExperiments();
  drawMonthGrid();
  renderWeek();
}

function updateLockButton() {
  const experiment = state.experiments.find((e) => e.id === state.selectedExperimentId);
  const canLock = experiment && experiment.status === "Draft";
  lockSelectedBtn.disabled = !canLock;
}

/* ── Placement (protocol → experiment draft) ────────────────────── */

function beginPlacement(protocolId, anchorDate) {
  if (!protocolId) return;
  const protocol = state.protocols.find((p) => p.id === protocolId);
  if (!protocol) return;

  state.placement = {
    protocolId,
    anchorDate,
  };

  updatePlacementPanel();
}

function clearPlacement() {
  state.placement = null;
  updatePlacementPanel();
}

function updatePlacementPanel() {
  if (!state.placement) {
    placementPanel.classList.add("hidden");
    return;
  }

  const protocol = state.protocols.find((p) => p.id === state.placement.protocolId);
  placementPanel.classList.remove("hidden");
  placementTitle.textContent = `Protocol Placement: ${protocol?.name || "Unknown"}`;
  placementCandidate.textContent = protocol?.name || "Protocol";
  $("#placement-subtitle").textContent = `Start date ${state.placement.anchorDate}. Drag the candidate chip to reposition before creating the draft.`;
}

function buildPlacementTasksByDate() {
  const out = new Map();
  if (!state.placement) return out;

  const protocol = state.protocols.find((p) => p.id === state.placement.protocolId);
  if (!protocol || !Array.isArray(protocol.steps) || protocol.steps.length === 0) return out;

  const ordered = topologicalSortSteps(protocol.steps);
  const datesByStep = new Map();

  for (const step of ordered) {
    const parents = parentStepIds(step);
    const date =
      parents.length === 0
        ? state.placement.anchorDate
        : addDays(
            parents
              .map((parentId) => datesByStep.get(parentId))
              .filter(Boolean)
              .sort()
              .at(-1),
            step.default_offset_days || 0,
          );
    datesByStep.set(step.id, date);

    const current = out.get(date) || [];
    current.push({ label: step.name, isRoot: parents.length === 0 });
    out.set(date, current);
  }

  return out;
}

/* ── Move staging (drag task to new date) ───────────────────────── */

function stageMove(experimentId, taskId, toDate) {
  const ctx = state.taskContext.get(taskId);
  if (!ctx) return false;
  const resolvedExperimentId = resolveTaskExperimentId(taskId, experimentId);
  if (!resolvedExperimentId) return false;

  // Dropping back to original date: cancel any staged move
  if (ctx.task.date === toDate) {
    if (state.pendingMove) {
      clearPendingMove();
    }
    return false;
  }

  // Constraint check: can't move before parent
  if (ctx.parentDate && toDate < ctx.parentDate) {
    showStatus(`Cannot move before prerequisite on ${ctx.parentDate}.`, true);
    return false;
  }

  const deltaDays = diffDays(ctx.task.date, toDate);

  // Moving earlier: only the dragged task shifts — downstream tasks keep their
  // dates because the offset represents real duration (e.g. 3-day incubation).
  // Moving later: cascade shift to all downstream tasks.
  const shiftedStepIds =
    deltaDays > 0
      ? computeShiftedStepIds(resolvedExperimentId, taskId)
      : new Set([ctx.task.step_id]);
  if (shiftedStepIds.size === 0) return false;

  state.pendingMove = {
    experimentId: resolvedExperimentId,
    taskId,
    fromDate: ctx.task.date,
    toDate,
    deltaDays,
    shiftedStepIds: Array.from(shiftedStepIds),
    label: `${ctx.protocolName}: ${ctx.task.step_name}`,
  };
  moveReason.value = ctx.task.deviation?.reason || "";
  updateMovePanel();

  // Single repaint
  drawMonthGrid();
  renderWeek({ skipFetch: true });
  return true;
}

function clearPendingMove() {
  state.pendingMove = null;
  updateMovePanel();
  drawMonthGrid();
  renderWeek({ skipFetch: true });
}

function updateMovePanel() {
  if (!adjustControls) return;
  if (!state.pendingMove) {
    adjustControls.classList.add("hidden");
    return;
  }

  adjustControls.classList.remove("hidden");
  const deltaLabel = formatSignedDays(state.pendingMove.deltaDays);
  const shiftCount = state.pendingMove.shiftedStepIds.length;
  moveSubtitle.innerHTML = `<strong>${escapeHtml(state.pendingMove.label)}</strong> &rarr; ${state.pendingMove.toDate} (${deltaLabel}). ${shiftCount > 1 ? `${shiftCount - 1} downstream task${shiftCount > 2 ? "s" : ""} will also shift.` : ""} <kbd>Enter</kbd> to confirm, <kbd>Esc</kbd> to cancel.`;
  moveSubtitle.classList.remove("error");
  moveConfirmBtn.disabled = !state.pendingMove;
}

async function commitPendingMove() {
  if (!state.pendingMove) return;
  const reason = (moveReason.value || "Manual deviation").trim();

  const res = await api(`/api/experiments/${state.pendingMove.experimentId}/tasks/move`, {
    method: "PATCH",
    body: JSON.stringify({
      task_id: state.pendingMove.taskId,
      new_date: state.pendingMove.toDate,
      reason,
    }),
  });

  if (res.error) {
    setAdjustHint(res.error, true);
    return;
  }

  showStatus("Move saved.");
  state.pendingMove = null;
  updateMovePanel();
  await refreshAll();
}

function setAdjustHint(message, isError = false) {
  if (!moveSubtitle) return;
  moveSubtitle.textContent = message || "";
  moveSubtitle.classList.toggle("error", Boolean(isError));
}

/* ── Week preview for pending move ──────────────────────────────── */

function buildWeekPreviewView(weekStartIso) {
  const pending = state.pendingMove;
  const deltaDays = pending?.deltaDays ?? 0;
  const shiftedStepIds = new Set(pending?.shiftedStepIds || []);
  const days = [];

  for (let i = 0; i < 7; i++) {
    const date = addDays(weekStartIso, i);
    const tasks = [];

    for (const exp of state.experiments) {
      for (const task of exp.tasks || []) {
        const isShifted =
          pending && exp.id === pending.experimentId && shiftedStepIds.has(task.step_id);
        const targetDate = isShifted ? addDays(task.date, deltaDays) : task.date;
        if (targetDate === date) {
          tasks.push(isShifted ? { ...task, date: targetDate, __ghost: true } : task);
        }
      }
    }

    tasks.sort((a, b) => (a.day_priority ?? 0) - (b.day_priority ?? 0));
    days.push({ date, tasks });
  }

  return { week_start: weekStartIso, days };
}

function isTaskShifted(taskId) {
  const pending = state.pendingMove;
  if (!pending) return false;
  const ctx = state.taskContext.get(taskId);
  return Boolean(
    ctx &&
      ctx.experimentId === pending.experimentId &&
      Array.isArray(pending.shiftedStepIds) &&
      pending.shiftedStepIds.includes(ctx.task.step_id),
  );
}

function computeShiftedStepIds(experimentId, taskId) {
  const exp = state.experiments.find((e) => e.id === experimentId);
  if (!exp) return new Set();
  const protocol = state.protocols.find((p) => p.id === exp.protocol_id);
  if (!protocol) return new Set();
  const movedTask = (exp.tasks || []).find((t) => t.id === taskId);
  if (!movedTask) return new Set();

  const childrenById = new Map();
  for (const step of protocol.steps || []) {
    for (const parentId of parentStepIds(step)) {
      const curr = childrenById.get(parentId) || [];
      curr.push(step.id);
      childrenById.set(parentId, curr);
    }
  }

  const shifted = new Set();
  const queue = [movedTask.step_id];
  while (queue.length) {
    const stepId = queue.shift();
    if (!stepId || shifted.has(stepId)) continue;
    shifted.add(stepId);
    for (const childId of childrenById.get(stepId) || []) {
      queue.push(childId);
    }
  }

  return shifted;
}

/* ── Placement / scheduling helpers ─────────────────────────────── */

function topologicalSortSteps(steps) {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const indegree = new Map();
  const children = new Map();

  steps.forEach((s) => {
    indegree.set(s.id, indegree.get(s.id) || 0);
    parentStepIds(s).forEach((parentId) => {
      if (!byId.has(parentId)) return;
      indegree.set(s.id, (indegree.get(s.id) || 0) + 1);
      const kids = children.get(parentId) || [];
      kids.push(s.id);
      children.set(parentId, kids);
    });
  });
  const orderedQueue = [];
  indegree.forEach((deg, id) => {
    if (deg === 0) orderedQueue.push(id);
  });

  const out = [];
  while (orderedQueue.length > 0) {
    const id = orderedQueue.shift();
    out.push(byId.get(id));
    const kids = children.get(id) || [];
    kids.forEach((childId) => {
      const next = (indegree.get(childId) || 0) - 1;
      indegree.set(childId, next);
      if (next === 0) orderedQueue.push(childId);
    });
  }

  return out.length === steps.length ? out : steps;
}

/* ── Experiment actions ─────────────────────────────────────────── */

async function finalizePlacement() {
  if (!state.placement) return;

  const scientist = currentScientistName();
  if (!scientist) {
    showStatus("Scientist name is required.", true);
    return;
  }

  const res = await api("/api/experiments", {
    method: "POST",
    body: JSON.stringify({
      protocol_id: state.placement.protocolId,
      start_date: state.placement.anchorDate,
      created_by: scientist,
    }),
  });

  if (res.error) {
    showStatus(res.error, true);
    return;
  }

  showStatus("Draft experiment created. Lock it manually when ready.");
  state.selectedExperimentId = res.id;
  clearPlacement();
  await refreshAll();
}

async function lockExperiment(experimentId) {
  const res = await api(`/api/experiments/${experimentId}/lock`, { method: "POST" });
  if (res.error) {
    showStatus(res.error, true);
    return;
  }
  showStatus("Experiment locked and marked live.");
  await refreshAll();
}

async function reorderTask(experimentId, taskId, newPriority) {
  const res = await api(`/api/experiments/${experimentId}/tasks/reorder`, {
    method: "PATCH",
    body: JSON.stringify({ task_id: taskId, new_priority: newPriority }),
  });

  if (res.error) {
    showStatus(res.error, true);
  }

  await refreshAll();
}

/* ── Colors ─────────────────────────────────────────────────────── */

function ensureExperimentColors() {
  const storageKey = "scischedule.experiment_colors_v1";
  let stored = {};
  try {
    stored = JSON.parse(localStorage.getItem(storageKey) || "{}");
  } catch {
    stored = {};
  }

  const assigned = {};
  for (const [expId, hue] of Object.entries(stored)) {
    if (typeof hue === "number" && hue >= 0 && hue < 360) {
      assigned[expId] = hue;
    }
  }

  const activeExperimentIds = experimentsActiveInPast30Days();
  const existingHues = () => Object.values(assigned);
  const activeHues = () =>
    activeExperimentIds.map((id) => assigned[id]).filter((hue) => typeof hue === "number");

  const sorted = [...state.experiments].sort(
    (a, b) => (a.created_at || 0) - (b.created_at || 0),
  );
  for (const exp of sorted) {
    if (typeof assigned[exp.id] === "number") continue;
    assigned[exp.id] = pickDistinctHue(existingHues(), activeHues());
  }

  state.experimentColorHues = assigned;
  localStorage.setItem(storageKey, JSON.stringify(assigned));
}

function experimentsActiveInPast30Days() {
  const todayIso = dateToISO(new Date());
  const cutoffIso = addDays(todayIso, -30);
  return state.experiments
    .filter((exp) =>
      (exp.tasks || []).some((task) => task.date >= cutoffIso && task.date <= todayIso),
    )
    .map((exp) => exp.id);
}

function pickDistinctHue(existing, active) {
  let bestHue = 0;
  let bestScore = -1;
  for (let hue = 0; hue < 360; hue += 5) {
    const distanceToActive = minCircularDistance(hue, active);
    const distanceToAny = minCircularDistance(hue, existing);
    const score = distanceToActive * 1000 + distanceToAny;
    if (score > bestScore) {
      bestScore = score;
      bestHue = hue;
    }
  }
  return bestHue;
}

function minCircularDistance(candidateHue, hues) {
  if (!Array.isArray(hues) || hues.length === 0) return 180;
  let min = 180;
  for (const hue of hues) {
    const raw = Math.abs(candidateHue - hue) % 360;
    const dist = Math.min(raw, 360 - raw);
    if (dist < min) min = dist;
  }
  return min;
}

function experimentColor(experimentId) {
  const hue = state.experimentColorHues[experimentId];
  if (typeof hue !== "number") return "#3a5a40";
  return `hsl(${hue} 70% 38%)`;
}

function shortExperimentLabel(experimentId) {
  if (!experimentId) return "exp";
  return `exp ${String(experimentId).slice(0, 4)}`;
}

function protocolColor(protocolId) {
  if (!protocolId) return PROTOCOL_COLORS[0];
  let h = 0;
  for (let i = 0; i < protocolId.length; i++) {
    h = (h * 31 + protocolId.charCodeAt(i)) >>> 0;
  }
  return PROTOCOL_COLORS[h % PROTOCOL_COLORS.length];
}

/* ── Task notes (localStorage) ──────────────────────────────────── */

function loadTaskNotes() {
  try {
    const parsed = JSON.parse(localStorage.getItem("scischedule.task_notes_v1") || "{}");
    state.taskNotes = parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    state.taskNotes = {};
  }
}

function saveTaskNotes() {
  localStorage.setItem("scischedule.task_notes_v1", JSON.stringify(state.taskNotes || {}));
}

function noteForTask(taskId) {
  const note = state.taskNotes?.[taskId];
  return typeof note === "string" && note.trim() ? note.trim() : "";
}

function editTaskNote(taskId, stepName) {
  const current = noteForTask(taskId);
  const entered = prompt(`Note for "${stepName}" (leave empty to clear):`, current);
  if (entered === null) return;
  const next = entered.trim();
  if (!next) {
    delete state.taskNotes[taskId];
  } else {
    state.taskNotes[taskId] = next;
  }
  saveTaskNotes();
  renderWeek();
}

/* ── Status / UI chrome ─────────────────────────────────────────── */

function showStatus(message, isError = false) {
  statusLine.textContent = message || "";
  statusLine.classList.toggle("error", Boolean(isError));
}

function initScientistProfile() {
  const key = "scischedule.scientist_name";
  let confirmedName = localStorage.getItem(key) || scientistNameInput.value || "Katherine";
  confirmedName = confirmedName.trim() || "Katherine";
  scientistNameInput.value = confirmedName;

  scientistNameInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      scientistNameInput.blur();
    } else if (e.key === "Escape") {
      scientistNameInput.value = confirmedName;
      scientistNameInput.blur();
    }
  });

  scientistNameInput.addEventListener("blur", () => {
    const next = (scientistNameInput.value || "").trim();
    if (!next || next === confirmedName) {
      scientistNameInput.value = confirmedName;
      return;
    }
    if (confirm(`Change default scientist from "${confirmedName}" to "${next}"?`)) {
      confirmedName = next;
      localStorage.setItem(key, confirmedName);
      showStatus(`Default scientist set to ${confirmedName}.`);
    } else {
      scientistNameInput.value = confirmedName;
    }
  });
}

function currentScientistName() {
  return (scientistNameInput.value || "Katherine").trim();
}

/* ── API / network ──────────────────────────────────────────────── */

async function api(url, opts = {}) {
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });

  const text = await res.text();
  if (!text) return {};

  try {
    return JSON.parse(text);
  } catch {
    return { error: text };
  }
}

/* ── Drag payload helpers ───────────────────────────────────────── */

function setDragPayload(event, payload) {
  state.activeDrag = payload || null;
  const dataTransfer = event?.dataTransfer;
  if (!dataTransfer || !payload) return;

  if (payload.kind === "task") {
    dataTransfer.effectAllowed = "move";
    writeDragData(dataTransfer, "text/task-id", payload.taskId || "");
    writeDragData(dataTransfer, "text/experiment-id", payload.experimentId || "");
    writeDragData(
      dataTransfer,
      "text/plain",
      `scischedule:task:${payload.experimentId || ""}:${payload.taskId || ""}`,
    );
    return;
  }

  if (payload.kind === "protocol") {
    dataTransfer.effectAllowed = "copyMove";
    writeDragData(dataTransfer, "text/protocol-id", payload.protocolId || "");
    if (payload.previewAnchor) {
      writeDragData(dataTransfer, "text/preview-anchor", "1");
    }
    writeDragData(dataTransfer, "text/plain", `scischedule:protocol:${payload.protocolId || ""}`);
  }
}

function readDragPayload(dataTransfer) {
  const fallback = state.activeDrag;
  if (!dataTransfer) return fallback;

  const taskId = safeGetData(dataTransfer, "text/task-id");
  const experimentId = resolveTaskExperimentId(
    taskId,
    safeGetData(dataTransfer, "text/experiment-id"),
  );
  if (taskId) {
    return { kind: "task", taskId, experimentId };
  }

  const protocolId = safeGetData(dataTransfer, "text/protocol-id");
  const previewAnchor = safeGetData(dataTransfer, "text/preview-anchor") === "1";
  if (protocolId || previewAnchor) {
    return {
      kind: "protocol",
      protocolId: protocolId || fallback?.protocolId || "",
      previewAnchor,
    };
  }

  const plain = safeGetData(dataTransfer, "text/plain");
  if (plain.startsWith("scischedule:task:")) {
    const [, , expFromPlain, taskFromPlain] = plain.split(":");
    if (taskFromPlain) {
      return {
        kind: "task",
        taskId: taskFromPlain,
        experimentId: resolveTaskExperimentId(taskFromPlain, expFromPlain || ""),
      };
    }
  }
  if (plain.startsWith("scischedule:protocol:")) {
    const [, , protoFromPlain] = plain.split(":");
    return {
      kind: "protocol",
      protocolId: protoFromPlain || fallback?.protocolId || "",
      previewAnchor: false,
    };
  }

  if (fallback?.kind === "task" && fallback.taskId) {
    return {
      kind: "task",
      taskId: fallback.taskId,
      experimentId: resolveTaskExperimentId(fallback.taskId, fallback.experimentId || ""),
    };
  }
  return fallback;
}

function resolveTaskExperimentId(taskId, experimentId) {
  if (experimentId) return experimentId;
  if (!taskId) return "";
  return state.taskContext.get(taskId)?.experimentId || "";
}

function safeGetData(dataTransfer, type) {
  if (!dataTransfer) return "";
  try {
    return dataTransfer.getData(type) || "";
  } catch {
    return "";
  }
}

function writeDragData(dataTransfer, type, value) {
  try {
    dataTransfer.setData(type, value);
  } catch {
    // Ignore browser quirks around custom types.
  }
}

function clearActiveDrag() {
  state.activeDrag = null;
}

/* ── Date utilities ─────────────────────────────────────────────── */

function addDays(dateStr, offset) {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() + Number(offset || 0));
  return dateToISO(d);
}

function diffDays(fromDate, toDate) {
  const start = new Date(fromDate + "T00:00:00");
  const end = new Date(toDate + "T00:00:00");
  return Math.round((end - start) / (24 * 60 * 60 * 1000));
}

function formatSignedDays(days) {
  const n = Number(days || 0);
  const sign = n > 0 ? "+" : "";
  return `${sign}${n}d`;
}

function dateToISO(date) {
  const y = date.getFullYear();
  const m = `${date.getMonth() + 1}`.padStart(2, "0");
  const d = `${date.getDate()}`.padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/* ── Misc helpers ───────────────────────────────────────────────── */

function parentStepIds(step) {
  if (!step) return [];
  if (Array.isArray(step.parent_step_ids)) return step.parent_step_ids;
  if (step.parent_step_id) return [step.parent_step_id];
  return [];
}

function escapeHtml(s) {
  return String(s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
