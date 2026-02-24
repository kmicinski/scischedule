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

const TASK_TAG_COLORS = [
  { name: "blue",   hex: "#2563eb", bg: "#dbeafe" },
  { name: "green",  hex: "#16a34a", bg: "#dcfce7" },
  { name: "red",    hex: "#dc2626", bg: "#fee2e2" },
  { name: "purple", hex: "#9333ea", bg: "#f3e8ff" },
  { name: "orange", hex: "#ea580c", bg: "#ffedd5" },
  { name: "teal",   hex: "#0d9488", bg: "#ccfbf1" },
  { name: "pink",   hex: "#db2777", bg: "#fce7f3" },
  { name: "yellow", hex: "#ca8a04", bg: "#fef9c3" },
];

const state = {
  now: new Date(),
  monthCursor: new Date(),
  weekCursor: new Date(),
  protocols: [],
  experiments: [],
  standaloneTasks: [],
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
  touchMoveSource: null,
  touchPlaceProtocol: null,
  inlineCreate: null,
  expandedTaskId: null,
  hiddenExperimentIds: new Set(JSON.parse(localStorage.getItem("hiddenExperimentIds") || "[]")),
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
const scientistNameEl = $("#scientist-name");
const appShell = document.querySelector(".app-shell");

/* ── Touch detection utilities ──────────────────────────────────── */

function isTouchDevice() {
  return "ontouchstart" in window || navigator.maxTouchPoints > 0;
}

function isMobileViewport() {
  return window.innerWidth <= 480;
}

function isTouchInteraction() {
  return isTouchDevice() && isMobileViewport();
}

function showTouchHint(message) {
  const hint = document.getElementById("touch-hint");
  if (!hint) return;
  hint.textContent = message;
  hint.style.display = "";
}

function dismissTouchHint() {
  const hint = document.getElementById("touch-hint");
  if (!hint) return;
  hint.style.display = "none";
}

function clearTouchMoveState() {
  state.touchMoveSource = null;
  state.touchPlaceProtocol = null;
  dismissTouchHint();
  document.querySelectorAll(".touch-selected").forEach((el) => el.classList.remove("touch-selected"));
  document.querySelectorAll(".touch-target-candidate").forEach((el) => el.classList.remove("touch-target-candidate"));
  clearDragConstraintZones();
}

init();

async function init() {
  loadTaskNotes();
  await loadIdentity();
  bindUi();
  await refreshAll();
}

async function loadIdentity() {
  const res = await api("/api/me");
  if (res.username) {
    state.username = res.username;
    state.displayName = res.display_name || res.username;
    const el = document.getElementById("scientist-name");
    if (el) el.textContent = state.displayName;
  }
}

function bindUi() {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      cancelInlineCreate();
      state.expandedTaskId = null;
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
    cancelInlineCreate();
    state.monthCursor.setMonth(state.monthCursor.getMonth() - 1);
    await renderMonth();
  });

  $("#month-next").addEventListener("click", async () => {
    cancelInlineCreate();
    state.monthCursor.setMonth(state.monthCursor.getMonth() + 1);
    await renderMonth();
  });

  $("#week-prev").addEventListener("click", async () => {
    cancelInlineCreate();
    state.weekCursor.setDate(state.weekCursor.getDate() - 7);
    await renderWeek();
  });

  $("#week-next").addEventListener("click", async () => {
    cancelInlineCreate();
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
  $("#add-prep-step").addEventListener("click", () => addPrepStepCard());

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

  // Outside-tap cancel for touch move/place
  document.addEventListener("click", (e) => {
    if (!isTouchInteraction()) return;
    if (!state.touchMoveSource && !state.touchPlaceProtocol) return;
    const target = e.target;
    if (
      target.closest(".task-row") ||
      target.closest(".week-task") ||
      target.closest(".month-cell") ||
      target.closest(".week-day") ||
      target.closest(".move-popover") ||
      target.closest(".touch-hint")
    ) return;
    clearTouchMoveState();
    drawMonthGrid();
    renderWeek({ skipFetch: true });
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

  // First pass: set names, details, parent indexes
  steps.forEach((step, idx) => {
    const card = cards[idx];
    if (!card) return;
    card.querySelector(".step-name").value = step.name || "";
    card.querySelector(".step-details").value = step.details || "";

    const pids = parentStepIds(step);
    const parentIdxs = pids
      .map((pid) => indexByStepId.get(pid))
      .filter((idx) => Number.isInteger(idx));
    card.dataset.parentIndexes = JSON.stringify(parentIdxs);
  });

  // Second pass: compute Day numbers from offsets by walking the DAG
  const dayNumbers = new Array(steps.length).fill(1);
  const computed = new Set();
  function computeDay(i) {
    if (computed.has(i)) return dayNumbers[i];
    computed.add(i);
    const pis = JSON.parse(cards[i].dataset.parentIndexes || "[]");
    if (pis.length === 0) {
      dayNumbers[i] = (steps[i].default_offset_days ?? 0) + 1;
    } else {
      const maxParentDay = Math.max(...pis.map((p) => computeDay(p)));
      dayNumbers[i] = maxParentDay + (steps[i].default_offset_days ?? 0);
    }
    return dayNumbers[i];
  }
  for (let i = 0; i < steps.length; i++) computeDay(i);

  // Apply computed Day numbers to inputs
  steps.forEach((_, idx) => {
    const card = cards[idx];
    if (!card) return;
    card.querySelector(".step-day").value = String(dayNumbers[idx]);
  });

  refreshAllStepCards();
  protocolDialog.showModal();
}

function addPrepStepCard() {
  const container = $("#steps-container");
  const cards = Array.from(container.querySelectorAll(".step-card"));

  // Find the lowest existing day value among prep steps (negative days)
  let lowestPrepDay = 0;
  for (const c of cards) {
    const d = parseInt(c.querySelector(".step-day")?.value || "1", 10);
    if (d < lowestPrepDay) lowestPrepDay = d;
  }
  const newDay = lowestPrepDay - 1;

  // Insert at the top of the container as a root step (no parents)
  addStepCard({ day: newDay, parentIndexes: [], prepend: true });

  // Scroll to top of steps
  container.firstElementChild?.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function addStepCard(opts) {
  const container = $("#steps-container");
  const cards = Array.from(container.querySelectorAll(".step-card"));
  const prevCard = cards.length > 0 ? cards[cards.length - 1] : null;
  const prevDay = prevCard ? parseInt(prevCard.querySelector(".step-day")?.value || "1", 10) : 0;
  const defaultDay = opts?.day ?? prevDay + 1;
  const defaultName = opts?.name ?? "";
  const defaultDetails = opts?.details ?? "";

  const prevIndex = cards.length > 0 ? cards.length - 1 : -1;
  const defaultParents = opts?.parentIndexes ?? (prevIndex >= 0 ? [prevIndex] : []);

  const prepend = opts?.prepend === true;
  const cardHtml = `<div class="step-card" data-parent-indexes="${escapeHtml(JSON.stringify(defaultParents))}">
      <div class="step-card-header">
        <span class="step-day-badge">${defaultDay}</span>
        <input class="step-name" placeholder="Step name" required />
        <input class="step-day" type="number" value="${defaultDay}" class="step-day-input-hidden" />
        <button type="button" class="step-repeat-btn" title="Repeat this step">&#x21bb;</button>
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
      </div>
    </div>`;

  if (prepend) {
    // Shift all existing parent indexes up by 1
    cards.forEach((c) => {
      let parents = JSON.parse(c.dataset.parentIndexes || "[]");
      parents = parents.map((p) => p + 1);
      c.dataset.parentIndexes = JSON.stringify(parents);
    });
    container.insertAdjacentHTML("afterbegin", cardHtml);
  } else {
    container.insertAdjacentHTML("beforeend", cardHtml);
  }
  const insertedCard = prepend ? container.firstElementChild : container.lastElementChild;

  if (defaultName) insertedCard.querySelector(".step-name").value = defaultName;
  if (defaultDetails) insertedCard.querySelector(".step-details").value = defaultDetails;

  insertedCard.querySelector(".step-delete-btn").addEventListener("click", () => {
    removeStepCard(insertedCard);
  });

  insertedCard.querySelector(".step-repeat-btn").addEventListener("click", () => {
    const myName = insertedCard.querySelector(".step-name").value;
    const myDetails = insertedCard.querySelector(".step-details").value;
    const myDayVal = parseInt(insertedCard.querySelector(".step-day").value || "1", 10);
    addStepCard({ name: myName, details: myDetails, day: myDayVal + 1 });
    // Scroll the new card into view
    container.lastElementChild.scrollIntoView({ behavior: "smooth", block: "nearest" });
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

  const dayInput = insertedCard.querySelector(".step-day");
  const dayBadge = insertedCard.querySelector(".step-day-badge");

  dayInput.addEventListener("input", () => {
    dayBadge.textContent = formatDayBadge(dayInput.value);
    updateDayBadgeStyle(dayBadge, parseInt(dayInput.value, 10));
    renderDagPreview();
  });

  dayInput.addEventListener("blur", () => {
    dayInput.classList.add("step-day-input-hidden");
    dayBadge.style.display = "";
  });

  dayInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      dayInput.classList.add("step-day-input-hidden");
      dayBadge.style.display = "";
    }
  });

  dayBadge.addEventListener("click", (e) => {
    e.stopPropagation();
    dayInput.classList.remove("step-day-input-hidden");
    dayBadge.style.display = "none";
    dayInput.focus();
    dayInput.select();
  });

  updateDayBadgeStyle(dayBadge, defaultDay);
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
    const dayBadge = card.querySelector(".step-day-badge");
    const dayInput = card.querySelector(".step-day");
    if (dayBadge && dayInput) {
      dayBadge.textContent = formatDayBadge(dayInput.value);
      updateDayBadgeStyle(dayBadge, parseInt(dayInput.value, 10));
    }

    renderDependencyChips(card, cards, idx);
    refreshDepAddOptions(card, cards, idx);
  });

  renderDagPreview();
}

function formatDayBadge(val) {
  const n = parseInt(val, 10);
  if (isNaN(n)) return "?";
  return n < 0 ? `${n}` : `${n}`;
}

function updateDayBadgeStyle(badge, day) {
  badge.classList.toggle("prep-day", day < 0);
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

  const dayValues = cards.map((c) => parseInt(c.querySelector(".step-day")?.value || "1", 10));

  let html = '<div class="dag-layers">';
  for (let d = 0; d <= maxDepth; d++) {
    if (d > 0) html += '<div class="dag-arrow-col">\u2192</div>';
    html += '<div class="dag-layer">';
    for (const i of layers[d]) {
      const dayLabel = dayValues[i] < 0 ? `D${dayValues[i]}` : `D${dayValues[i]}`;
      const prepClass = dayValues[i] < 0 ? " dag-node-prep" : "";
      html += `<div class="dag-node${prepClass}"><span class="dag-node-num">${escapeHtml(dayLabel)}</span><span class="dag-node-name">${escapeHtml(names[i])}</span></div>`;
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
  const days = cards.map((c) => parseInt(c.querySelector(".step-day").value || "1", 10));
  const parentIndexes = cards.map((c) => JSON.parse(c.dataset.parentIndexes || "[]"));

  const steps = cards.map((card, i) => {
    const pis = parentIndexes[i];
    let offset;
    if (pis.length === 0) {
      offset = days[i] - 1; // root: offset from start_date (Day 1 = offset 0, Day -2 = offset -3)
    } else {
      const maxParentDay = Math.max(...pis.map((p) => days[p]));
      offset = days[i] - maxParentDay;
    }
    return {
      name: card.querySelector(".step-name").value,
      details: card.querySelector(".step-details").value,
      parent_step_indexes: pis,
      default_offset_days: offset,
    };
  });

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

  // On touch, prompt user to place the new protocol
  if (!isEdit && isTouchInteraction() && saved.id) {
    state.touchPlaceProtocol = saved.id;
    showTouchHint("Tap a date to place this protocol");
  }

  return true;
}

/* ── Data refresh ───────────────────────────────────────────────── */

async function refreshAll() {
  const [protocols, experiments, standaloneTasks] = await Promise.all([
    api("/api/protocols"),
    api("/api/experiments"),
    api("/api/tasks"),
  ]);
  state.protocols = Array.isArray(protocols) ? protocols : [];
  state.experiments = Array.isArray(experiments) ? experiments : [];
  state.standaloneTasks = Array.isArray(standaloneTasks) ? standaloneTasks : [];

  ensureExperimentColors();
  rebuildTaskContext();
  renderProtocols();
  renderExperiments();
  updateLockButton();
  updatePlacementPanel();
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

/* ── Standalone tasks helpers ───────────────────────────────────── */

function standaloneTasksUnassigned() {
  return state.standaloneTasks
    .filter((t) => !t.date)
    .sort((a, b) => {
      const oa = a.sort_order || 0;
      const ob = b.sort_order || 0;
      if (oa !== ob) return oa - ob;
      return (a.created_at || 0) - (b.created_at || 0);
    });
}

function standaloneTasksForDate(dateStr) {
  return state.standaloneTasks
    .filter((t) => t.date && t.date === dateStr)
    .sort((a, b) => {
      const oa = a.sort_order || 0;
      const ob = b.sort_order || 0;
      if (oa !== ob) return oa - ob;
      return (a.created_at || 0) - (b.created_at || 0);
    });
}

function cancelInlineCreate() {
  if (!state.inlineCreate) return;
  const el = state.inlineCreate.element;
  if (el && el.parentNode) el.remove();
  state.inlineCreate = null;
}

function beginInlineCreate(date, parentEl) {
  cancelInlineCreate();

  const card = document.createElement("div");
  card.className = "inline-create-card";
  card.addEventListener("click", (e) => e.stopPropagation());

  const input = document.createElement("input");
  input.type = "text";
  input.className = "inline-create-input";
  input.placeholder = "New task...";
  card.appendChild(input);
  parentEl.appendChild(card);

  state.inlineCreate = { date, element: card };

  input.focus();

  input.addEventListener("keydown", async (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const title = input.value.trim();
      if (!title) { cancelInlineCreate(); return; }
      const body = { title };
      if (date) body.date = date;
      const res = await api("/api/tasks", {
        method: "POST",
        body: JSON.stringify(body),
      });
      cancelInlineCreate();
      if (res.error) { showStatus(res.error, true); return; }
      await refreshAll();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancelInlineCreate();
    }
  });

  input.addEventListener("blur", () => {
    setTimeout(() => {
      if (state.inlineCreate?.element === card) cancelInlineCreate();
    }, 150);
  });
}

async function toggleExperimentTaskCompleted(experimentId, taskId) {
  await api(`/api/experiments/${experimentId}/tasks/${taskId}/complete`, {
    method: "PATCH",
  });
  await refreshAll();
}

async function toggleStandaloneTaskCompleted(taskId) {
  const task = state.standaloneTasks.find((t) => t.id === taskId);
  if (!task) return;
  await api(`/api/tasks/${taskId}`, {
    method: "PATCH",
    body: JSON.stringify({ completed: !task.completed }),
  });
  await refreshAll();
}

async function deleteStandaloneTask(taskId) {
  await api(`/api/tasks/${taskId}`, { method: "DELETE" });
  state.expandedTaskId = null;
  await refreshAll();
}

async function deleteExperiment(experimentId) {
  if (!confirm("Delete this experiment? This cannot be undone.")) return;
  await api(`/api/experiments/${experimentId}`, { method: "DELETE" });
  if (state.selectedExperimentId === experimentId) {
    state.selectedExperimentId = null;
  }
  await refreshAll();
}

async function saveExpandedStandaloneTask(taskId) {
  const card = document.querySelector(`.standalone-expanded[data-task-id="${taskId}"]`);
  if (!card) return;
  const title = card.querySelector(".standalone-edit-title")?.value.trim();
  const notes = card.querySelector(".standalone-edit-notes")?.value || "";
  const time_of_day = card.querySelector(".standalone-edit-time")?.value || null;
  const selectedSwatch = card.querySelector(".color-swatch.selected");
  const color_tag = selectedSwatch ? parseInt(selectedSwatch.dataset.colorIndex, 10) : null;

  const body = { title, notes, time_of_day: time_of_day || null, color_tag };
  await api(`/api/tasks/${taskId}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
  state.expandedTaskId = null;
  await refreshAll();
}

function buildExpandedStandaloneCard(task, weekView) {
  const card = document.createElement("div");
  card.className = "standalone-expanded";
  card.dataset.taskId = task.id;
  card.addEventListener("click", (e) => e.stopPropagation());

  const titleInput = document.createElement("input");
  titleInput.type = "text";
  titleInput.className = "standalone-edit-title";
  titleInput.value = task.title;
  card.appendChild(titleInput);

  const notesArea = document.createElement("textarea");
  notesArea.className = "standalone-edit-notes";
  notesArea.placeholder = "Notes...";
  notesArea.value = task.notes || "";
  notesArea.rows = 2;
  card.appendChild(notesArea);

  const timeInput = document.createElement("input");
  timeInput.type = "text";
  timeInput.className = "standalone-edit-time";
  timeInput.placeholder = "Time (e.g. 09:00)";
  timeInput.value = task.time_of_day || "";
  card.appendChild(timeInput);

  // Color swatches
  const swatchRow = document.createElement("div");
  swatchRow.className = "color-swatch-row";
  TASK_TAG_COLORS.forEach((color, i) => {
    const swatch = document.createElement("span");
    swatch.className = "color-swatch";
    swatch.dataset.colorIndex = i;
    swatch.style.background = color.hex;
    if (task.color_tag === i) swatch.classList.add("selected");
    swatch.addEventListener("click", () => {
      swatchRow.querySelectorAll(".color-swatch").forEach((s) => s.classList.remove("selected"));
      swatch.classList.add("selected");
    });
    swatchRow.appendChild(swatch);
  });
  const clearSwatch = document.createElement("span");
  clearSwatch.className = "clear-swatch";
  clearSwatch.textContent = "\u00d7";
  clearSwatch.title = "No color";
  clearSwatch.addEventListener("click", () => {
    swatchRow.querySelectorAll(".color-swatch").forEach((s) => s.classList.remove("selected"));
  });
  swatchRow.appendChild(clearSwatch);
  card.appendChild(swatchRow);

  // Day picker (assign/clear date within current week)
  if (weekView && weekView.days) {
    const dayPickerRow = document.createElement("div");
    dayPickerRow.className = "day-picker-row";

    const dayLabel = document.createElement("span");
    dayLabel.className = "day-picker-label";
    dayLabel.textContent = "Day:";
    dayPickerRow.appendChild(dayLabel);

    for (const wd of weekView.days) {
      const dayBtn = document.createElement("button");
      dayBtn.type = "button";
      dayBtn.className = "day-picker-btn";
      const d = new Date(wd.date + "T00:00:00");
      dayBtn.textContent = d.toLocaleDateString(undefined, { weekday: "short" });
      dayBtn.title = wd.date;
      if (task.date === wd.date) dayBtn.classList.add("selected");
      dayBtn.addEventListener("click", async () => {
        await api(`/api/tasks/${task.id}`, {
          method: "PATCH",
          body: JSON.stringify({ date: wd.date }),
        });
        state.expandedTaskId = null;
        await refreshAll();
      });
      dayPickerRow.appendChild(dayBtn);
    }

    // Clear button to unassign date
    if (task.date) {
      const clearBtn = document.createElement("button");
      clearBtn.type = "button";
      clearBtn.className = "day-picker-btn day-picker-clear";
      clearBtn.textContent = "\u00d7";
      clearBtn.title = "Unassign date";
      clearBtn.addEventListener("click", async () => {
        await api(`/api/tasks/${task.id}`, {
          method: "PATCH",
          body: JSON.stringify({ date: null }),
        });
        state.expandedTaskId = null;
        await refreshAll();
      });
      dayPickerRow.appendChild(clearBtn);
    }

    card.appendChild(dayPickerRow);
  }

  // Actions
  const actions = document.createElement("div");
  actions.className = "standalone-expanded-actions";

  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.className = "btn primary";
  saveBtn.textContent = "Save";
  saveBtn.addEventListener("click", () => saveExpandedStandaloneTask(task.id));
  actions.appendChild(saveBtn);

  const deleteBtn = document.createElement("button");
  deleteBtn.type = "button";
  deleteBtn.className = "btn danger-btn";
  deleteBtn.textContent = "Delete";
  deleteBtn.addEventListener("click", () => deleteStandaloneTask(task.id));
  actions.appendChild(deleteBtn);

  card.appendChild(actions);
  return card;
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
    if (!isTouchInteraction()) li.draggable = true;
    li.dataset.protocolId = p.id;
    li.style.borderLeft = `4px solid ${protocolColor(p.id)}`;

    const content = document.createElement("div");
    content.className = "protocol-item-content";
    content.innerHTML = `<strong>${escapeHtml(p.name)}</strong><br/><small>${escapeHtml(p.description || "")}</small>`;
    li.appendChild(content);

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "protocol-delete-x";
    deleteBtn.title = "Delete protocol";
    deleteBtn.textContent = "\u00d7";
    deleteBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      deleteProtocol(p.id, p.name);
    });
    li.appendChild(deleteBtn);

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

async function deleteProtocol(protocolId, protocolName) {
  if (!confirm(`Delete protocol "${protocolName}"? This cannot be undone.`)) return;
  const res = await api(`/api/protocols/${protocolId}`, { method: "DELETE" });
  if (res && res.error) {
    showStatus(res.error, true);
    return;
  }
  showStatus("Protocol deleted.");
  await refreshAll();
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

    const isHidden = state.hiddenExperimentIds.has(exp.id);
    if (isHidden) li.classList.add("hidden-experiment");

    li.innerHTML = `
      <div class="experiment-item-header">
        <button class="experiment-visibility-btn" title="${isHidden ? "Show" : "Hide"} on calendar">${isHidden ? "&#9711;" : "&#9679;"}</button>
        <span class="experiment-color-dot" style="background:${experimentColor(exp.id)}"></span>
        <span class="experiment-item-name">${escapeHtml(exp.protocol_name)}</span>
        <span class="experiment-status-badge ${statusClass}">${escapeHtml(exp.status)}</span>
      </div>
      <div class="experiment-item-meta">${escapeHtml(metaParts.join(" · "))} · ${escapeHtml(exp.created_by)}</div>
    `;

    li.querySelector(".experiment-visibility-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      if (state.hiddenExperimentIds.has(exp.id)) {
        state.hiddenExperimentIds.delete(exp.id);
      } else {
        state.hiddenExperimentIds.add(exp.id);
      }
      localStorage.setItem("hiddenExperimentIds", JSON.stringify([...state.hiddenExperimentIds]));
      renderExperiments();
      drawMonthGrid();
      renderWeek({ skipFetch: true });
    });

    li.addEventListener("click", () => {
      if (state.selectedExperimentId === exp.id) {
        selectExperiment(null);
      } else {
        selectExperiment(exp.id);
      }
    });

    if (state.selectedExperimentId === exp.id) {
      const deleteBtn = document.createElement("button");
      deleteBtn.type = "button";
      deleteBtn.className = "btn danger-btn experiment-delete-btn";
      deleteBtn.textContent = "Delete";
      deleteBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        deleteExperiment(exp.id);
      });
      li.appendChild(deleteBtn);
    }

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

    div.addEventListener("click", (e) => {
      // Touch move: tap destination cell
      if (isTouchInteraction() && state.touchMoveSource) {
        const src = state.touchMoveSource;
        const ctx = state.taskContext.get(src.taskId);
        if (ctx?.parentDate && cell.date < ctx.parentDate) {
          showStatus(`Cannot move before prerequisite on ${ctx.parentDate}.`, true);
          return;
        }
        clearTouchMoveState();
        stageMove(src.experimentId, src.taskId, cell.date);
        return;
      }
      // Touch place protocol
      if (isTouchInteraction() && state.touchPlaceProtocol) {
        beginPlacement(state.touchPlaceProtocol, cell.date);
        state.touchPlaceProtocol = null;
        dismissTouchHint();
        drawMonthGrid();
        return;
      }
      if (state.placement) {
        state.placement.anchorDate = cell.date;
        updatePlacementPanel();
        drawMonthGrid();
        return;
      }
      if (state.pendingMove) return;
      // Inline create standalone task
      if (!e.target.closest(".task-row") && !e.target.closest(".standalone-task-row") && !e.target.closest(".inline-create-card") && !e.target.closest(".standalone-expanded")) {
        beginInlineCreate(cell.date, div);
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
          previewDragMove(
            resolveTaskExperimentId(drag.taskId, drag.experimentId),
            drag.taskId,
            cell.date,
          );
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
        if (state.pendingMove?.preview && state.pendingMove.toDate === cell.date) {
          // Promote existing preview to staged move
          delete state.pendingMove.preview;
          showMovePopover(cell.date);
          drawMonthGrid();
          renderWeek({ skipFetch: true });
        } else {
          stageMove(
            resolveTaskExperimentId(drag.taskId, drag.experimentId),
            drag.taskId,
            cell.date,
          );
        }
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
    if (state.hiddenExperimentIds.has(ctx.experimentId)) continue;

    const isMovingAway =
      pending &&
      ctx.experimentId === pending.experimentId &&
      shiftedStepIds.has(task.step_id);

    rows.push({
      kind: "task",
      task,
      text: task.step_name,
      experimentId: ctx.experimentId,
      parentDate: ctx.parentDate,
      nextDates: ctx.nextDates,
      deviation: Boolean(task.deviation),
      movingAway: isMovingAway,
    });
  }

  // 2. Ghost rows — tasks projected to arrive at this cell's date
  if (pending && shiftedStepIds && !state.hiddenExperimentIds.has(pending.experimentId)) {
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
          text: task.step_name,
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

  // 4. Standalone tasks for this date
  const saTasks = standaloneTasksForDate(cell.date);
  for (const sa of saTasks) {
    rows.push({ kind: "standalone", task: sa });
  }

  const visibleRows = rows.slice(0, maxRows);

  visibleRows.forEach((row) => {
    if (row.kind === "standalone") {
      cellEl.appendChild(buildMonthStandaloneRow(row.task));
      return;
    }
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
      if (!isTouchInteraction()) div.draggable = true;
      div.addEventListener("dragstart", (e) => {
        // Clear any existing pending move when starting a new drag
        if (state.pendingMove) {
          state.pendingMove = null;
          dismissMovePopover();
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
        if (state.pendingMove?.preview) {
          state.pendingMove = null;
          drawMonthGrid();
        }
        clearActiveDrag();
      });

      div.addEventListener("click", (e) => {
        e.stopPropagation();
        if (isTouchInteraction()) {
          // Touch: toggle selection for tap-to-move
          if (state.touchMoveSource && state.touchMoveSource.taskId === row.task.id) {
            clearTouchMoveState();
            drawMonthGrid();
            renderWeek({ skipFetch: true });
          } else {
            clearTouchMoveState();
            state.touchMoveSource = { taskId: row.task.id, experimentId: row.experimentId };
            div.classList.add("touch-selected");
            showDragConstraintZones(row.task.id);
            showTouchHint("Tap a date to move this task");
            // Highlight valid target cells
            document.querySelectorAll(".month-cell").forEach((c) => {
              if (!c.classList.contains("drag-invalid-zone")) {
                c.classList.add("touch-target-candidate");
              }
            });
          }
        } else {
          selectExperiment(row.experimentId);
        }
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
      if (!isTouchInteraction()) div.draggable = true;
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

function buildMonthStandaloneRow(task) {
  const div = document.createElement("div");
  div.className = "standalone-task-row";
  if (task.completed) div.classList.add("completed");
  div.dataset.standaloneTaskId = task.id;
  div.addEventListener("click", (e) => e.stopPropagation());

  const colorTag = typeof task.color_tag === "number" && task.color_tag < 8
    ? TASK_TAG_COLORS[task.color_tag]
    : null;
  if (colorTag) div.style.setProperty("--tag-color", colorTag.hex);

  const title = document.createElement("span");
  title.className = "standalone-title";
  title.textContent = task.title;
  title.addEventListener("click", (e) => {
    e.stopPropagation();
    if (state.expandedTaskId === task.id) {
      state.expandedTaskId = null;
    } else {
      state.expandedTaskId = task.id;
    }
    drawMonthGrid();
    renderWeek({ skipFetch: true });
  });
  div.appendChild(title);

  if (task.time_of_day) {
    const time = document.createElement("span");
    time.className = "standalone-time";
    time.textContent = task.time_of_day;
    div.appendChild(time);
  }

  const delBtn = document.createElement("button");
  delBtn.type = "button";
  delBtn.className = "standalone-delete-x";
  delBtn.textContent = "\u00d7";
  delBtn.title = "Delete task";
  delBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (confirm("Delete this task?")) deleteStandaloneTask(task.id);
  });
  div.appendChild(delBtn);

  const wrapper = document.createElement("div");
  wrapper.appendChild(div);

  if (state.expandedTaskId === task.id) {
    wrapper.appendChild(buildExpandedStandaloneCard(task));
  }

  return wrapper;
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

  // "This Week" unassigned tasks column (left side)
  const unassigned = standaloneTasksUnassigned();
  const unassignedWrap = document.createElement("section");
  unassignedWrap.className = "week-day week-unassigned-column";
  renderWeekUnassignedContent(unassignedWrap, unassigned, weekView);
  weekGrid.appendChild(unassignedWrap);

  for (const wd of weekView.days) {
    const wrap = document.createElement("section");
    wrap.className = "week-day";
    wrap.dataset.date = wd.date;

    const d = new Date(wd.date + "T00:00:00");
    const dow = d.getDay();
    if (wd.date === todayISO) wrap.classList.add("today");
    if (dow === 0 || dow === 6) wrap.classList.add("weekend");

    // Dragover: lightweight preview
    wrap.addEventListener("dragover", (e) => {
      const drag = readDragPayload(e.dataTransfer);
      if (drag?.kind === "standalone" && drag.taskId) {
        e.preventDefault();
        wrap.classList.add("drag-over");
        return;
      }
      if (drag?.kind === "task" && drag.taskId) {
        const ctx = state.taskContext.get(drag.taskId);
        if (ctx?.parentDate && wd.date < ctx.parentDate) {
          // Invalid drop target
        } else {
          e.preventDefault();
          wrap.classList.add("drag-over");
          previewDragMove(
            resolveTaskExperimentId(drag.taskId, drag.experimentId),
            drag.taskId,
            wd.date,
          );
        }
      }
    });

    wrap.addEventListener("dragleave", () => {
      wrap.classList.remove("drag-over");
    });

    // Drop: promote preview or stage move
    wrap.addEventListener("drop", async (e) => {
      e.preventDefault();
      wrap.classList.remove("drag-over");
      const drag = readDragPayload(e.dataTransfer);
      if (drag?.kind === "standalone" && drag.taskId) {
        await api(`/api/tasks/${drag.taskId}`, {
          method: "PATCH",
          body: JSON.stringify({ date: wd.date }),
        });
        clearActiveDrag();
        await refreshAll();
        return;
      }
      if (drag?.kind === "task" && drag.taskId) {
        if (state.pendingMove?.preview && state.pendingMove.toDate === wd.date) {
          delete state.pendingMove.preview;
          showMovePopover(wd.date);
          drawMonthGrid();
          renderWeek({ skipFetch: true });
        } else {
          stageMove(
            resolveTaskExperimentId(drag.taskId, drag.experimentId),
            drag.taskId,
            wd.date,
          );
        }
      }
      clearActiveDrag();
    });

    // Touch move: tap on week day to move task here
    wrap.addEventListener("click", (e) => {
      if (!isTouchInteraction() || !state.touchMoveSource) return;
      if (e.target.closest(".week-task")) return;
      const src = state.touchMoveSource;
      const ctx = state.taskContext.get(src.taskId);
      if (ctx?.parentDate && wd.date < ctx.parentDate) {
        showStatus(`Cannot move before prerequisite on ${ctx.parentDate}.`, true);
        return;
      }
      clearTouchMoveState();
      stageMove(src.experimentId, src.taskId, wd.date);
    });

    renderWeekDayContent(wrap, wd, weekView);
    weekGrid.appendChild(wrap);
  }
}

function renderWeekDayContent(wrap, wd, weekView) {
  const tasks = (wd.tasks || []).filter((t) => {
    const ctx = state.taskContext.get(t.id);
    return !ctx || !state.hiddenExperimentIds.has(ctx.experimentId);
  });
  const saTasks = standaloneTasksForDate(wd.date);
  const d = new Date(wd.date + "T00:00:00");
  const taskCount = tasks.length + saTasks.length;

  // Header with weekday, date, and task count
  const header = document.createElement("div");
  header.className = "week-day-header";
  header.innerHTML = `<span class="week-day-label">${d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}</span>${taskCount > 0 ? `<span class="week-day-count">${taskCount}</span>` : ""}`;
  wrap.appendChild(header);

  // Task container (also serves as drop target for empty days)
  const container = document.createElement("div");
  container.className = "week-day-tasks";
  wrap.appendChild(container);

  // Merge experiment tasks and standalone tasks into a single sorted list
  const allItems = [];
  for (const task of tasks) {
    allItems.push({ kind: "experiment", task, order: task.day_priority ?? 0 });
  }
  for (const sa of saTasks) {
    allItems.push({ kind: "standalone", task: sa, order: sa.sort_order ?? 0 });
  }
  allItems.sort((a, b) => {
    if (a.order !== b.order) return a.order - b.order;
    // Tiebreak: experiments before standalone, then by created_at
    if (a.kind !== b.kind) return a.kind === "experiment" ? -1 : 1;
    return (a.task.created_at || 0) - (b.task.created_at || 0);
  });

  let expIndex = 0;
  allItems.forEach((item) => {
    if (item.kind === "experiment") {
      container.appendChild(buildWeekTaskCard(item.task, expIndex++));
    } else {
      container.appendChild(buildWeekStandaloneCard(item.task, weekView));
    }
  });

  if (taskCount === 0) {
    const empty = document.createElement("div");
    empty.className = "week-day-empty";
    empty.textContent = "No tasks";
    container.appendChild(empty);
  }

  // Click empty area to inline-create
  wrap.addEventListener("click", (e) => {
    if (isTouchInteraction() && state.touchMoveSource) return;
    if (state.placement || state.pendingMove) return;
    if (e.target.closest(".week-task") || e.target.closest(".standalone-task-card") || e.target.closest(".inline-create-card") || e.target.closest(".standalone-expanded")) return;
    beginInlineCreate(wd.date, container);
  });
}

function renderWeekUnassignedContent(wrap, unassignedTasks, weekView) {
  const taskCount = unassignedTasks.length;

  const header = document.createElement("div");
  header.className = "week-day-header week-unassigned-header";

  const headerLabel = document.createElement("span");
  headerLabel.className = "week-day-label";
  headerLabel.textContent = "This Week";
  header.appendChild(headerLabel);

  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.className = "week-unassigned-add-btn";
  addBtn.textContent = "+";
  addBtn.title = "Add unassigned task";
  addBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    beginInlineCreate(null, container);
  });
  header.appendChild(addBtn);

  if (taskCount > 0) {
    const count = document.createElement("span");
    count.className = "week-day-count";
    count.textContent = taskCount;
    header.appendChild(count);
  }

  wrap.appendChild(header);

  const container = document.createElement("div");
  container.className = "week-day-tasks";
  wrap.appendChild(container);

  unassignedTasks.forEach((sa) => {
    container.appendChild(buildWeekStandaloneCard(sa, weekView));
  });

  if (taskCount === 0) {
    const empty = document.createElement("div");
    empty.className = "week-day-empty week-unassigned-empty";
    empty.textContent = "Click + to add a task for this week";
    container.appendChild(empty);
  }

  // Drag-and-drop: accept standalone tasks to unassign their date
  wrap.addEventListener("dragover", (e) => {
    const drag = readDragPayload(e.dataTransfer);
    if (drag?.kind === "standalone") {
      e.preventDefault();
      wrap.classList.add("drag-over");
    }
  });
  wrap.addEventListener("dragleave", () => wrap.classList.remove("drag-over"));
  wrap.addEventListener("drop", async (e) => {
    e.preventDefault();
    wrap.classList.remove("drag-over");
    const drag = readDragPayload(e.dataTransfer);
    if (drag?.kind === "standalone" && drag.taskId) {
      await api(`/api/tasks/${drag.taskId}`, {
        method: "PATCH",
        body: JSON.stringify({ date: null }),
      });
      clearActiveDrag();
      await refreshAll();
    }
  });

  // Click empty area to inline-create with null date
  wrap.addEventListener("click", (e) => {
    if (state.placement || state.pendingMove) return;
    if (e.target.closest(".standalone-task-card") || e.target.closest(".inline-create-card") || e.target.closest(".standalone-expanded")) return;
    beginInlineCreate(null, container);
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
  if (task.completed) classes.push("completed");
  card.className = classes.join(" ");
  card.style.borderLeftColor = experimentColor(expId);
  card.draggable = !shifted && !isTouchInteraction();
  card.dataset.taskId = task.id;
  card.dataset.experimentId = expId;
  card.dataset.date = task.date;

  card.addEventListener("dragstart", (e) => {
    if (state.pendingMove) {
      state.pendingMove = null;
      dismissMovePopover();
    }
    setDragPayload(e, {
      kind: "task",
      taskId: task.id,
      experimentId: expId,
    });
  });

  card.addEventListener("dragend", () => {
    if (state.pendingMove?.preview) {
      state.pendingMove = null;
      drawMonthGrid();
    }
    clearActiveDrag();
  });

  card.addEventListener("click", (e) => {
    if (e.target.closest(".standalone-check-wrap")) return;
    if (isTouchInteraction()) {
      e.stopPropagation();
      if (state.touchMoveSource && state.touchMoveSource.taskId === task.id) {
        clearTouchMoveState();
        drawMonthGrid();
        renderWeek({ skipFetch: true });
      } else {
        clearTouchMoveState();
        state.touchMoveSource = { taskId: task.id, experimentId: expId };
        card.classList.add("touch-selected");
        showTouchHint("Tap a day to move this task");
      }
    } else {
      selectExperiment(expId);
    }
  });

  // Intra-day reorder: dragover/drop on card (accepts experiment & standalone drags)
  card.addEventListener("dragover", (e) => {
    if (state.pendingMove) return;
    const drag = readDragPayload(e.dataTransfer);
    if (!drag) return;
    if (drag.kind === "task") {
      const draggingCtx = state.taskContext.get(drag.taskId);
      if (!draggingCtx || draggingCtx.task.date !== task.date) return;
    } else if (drag.kind === "standalone") {
      if (!drag.taskId || drag.taskId === task.id) return;
    } else return;
    e.preventDefault();
    e.stopPropagation();
    card.classList.remove("drop-before", "drop-after");
    card.classList.add(e.offsetY < card.clientHeight / 2 ? "drop-before" : "drop-after");
  });

  card.addEventListener("dragleave", () => card.classList.remove("drop-before", "drop-after"));

  card.addEventListener("drop", async (e) => {
    if (state.pendingMove) return;
    e.preventDefault();
    e.stopPropagation();
    card.classList.remove("drop-before", "drop-after");
    const drag = readDragPayload(e.dataTransfer);
    if (!drag) return;
    const insertBefore = e.offsetY < card.clientHeight / 2;
    const targetOrder = task.day_priority ?? 0;
    const newOrder = insertBefore ? targetOrder - 1 : targetOrder + 1;

    if (drag.kind === "task" && drag.taskId && drag.taskId !== task.id) {
      const draggingCtx = state.taskContext.get(drag.taskId);
      if (!draggingCtx || draggingCtx.task.date !== task.date) return;
      const dragExpId = resolveTaskExperimentId(drag.taskId, drag.experimentId);
      clearActiveDrag();
      await reorderTask(dragExpId, drag.taskId, newOrder);
    } else if (drag.kind === "standalone" && drag.taskId) {
      await api(`/api/tasks/${drag.taskId}`, {
        method: "PATCH",
        body: JSON.stringify({ sort_order: newOrder }),
      });
      clearActiveDrag();
      await refreshAll();
    }
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
      ${!shifted ? '<label class="standalone-check-wrap"><input type="checkbox" class="standalone-check" /></label>' : ""}
      ${!shifted ? '<span class="week-drag-handle" title="Drag to reorder">&#8942;&#8942;</span>' : ""}
      <span class="week-task-priority">${index + 1}</span>
    </div>
    <div class="week-task-body">
      <div class="week-task-step" style="font-weight:700">${escapeHtml(stepName)}</div>
      <div class="week-task-status-line">${statusHtml}</div>
    </div>
    <div class="week-task-actions">
      ${!shifted ? '<button type="button" class="week-note-btn" title="Add or edit task note">Note</button>' : ""}
      ${!shifted ? `<button type="button" class="week-exp-delete-btn" data-exp-id="${expId}" title="Delete this experiment">\u00d7</button>` : ""}
    </div>
    ${taskNote ? `<div class="week-note">${escapeHtml(taskNote)}</div>` : ""}
  `;

  if (!shifted) {
    const checkEl = card.querySelector(".standalone-check");
    if (checkEl) {
      checkEl.checked = task.completed;
      const checkWrap = checkEl.closest(".standalone-check-wrap");
      checkWrap.addEventListener("click", (e) => e.stopPropagation());
      checkEl.addEventListener("change", (e) => {
        e.stopPropagation();
        toggleExperimentTaskCompleted(expId, task.id);
      });
    }
    const noteBtn = card.querySelector(".week-note-btn");
    if (noteBtn) {
      noteBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        editTaskNote(task.id, task.step_name);
      });
    }
    const expDelBtn = card.querySelector(".week-exp-delete-btn");
    if (expDelBtn) {
      expDelBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        deleteExperiment(expId);
      });
    }
  }

  return card;
}

function buildWeekStandaloneCard(task, weekView) {
  if (state.expandedTaskId === task.id) {
    const expanded = buildExpandedStandaloneCard(task, weekView);
    return expanded;
  }

  const card = document.createElement("div");
  card.className = "standalone-task-card";
  if (task.completed) card.classList.add("completed");
  card.dataset.standaloneTaskId = task.id;

  // Drag-and-drop support
  card.draggable = !isTouchInteraction();
  card.addEventListener("dragstart", (e) => {
    setDragPayload(e, { kind: "standalone", taskId: task.id });
  });
  card.addEventListener("dragend", () => clearActiveDrag());

  const colorTag = typeof task.color_tag === "number" && task.color_tag < 8
    ? TASK_TAG_COLORS[task.color_tag]
    : null;
  if (colorTag) {
    card.style.borderLeftColor = colorTag.hex;
  }

  const checkWrap = document.createElement("label");
  checkWrap.className = "standalone-check-wrap";
  checkWrap.addEventListener("click", (e) => e.stopPropagation());
  const check = document.createElement("input");
  check.type = "checkbox";
  check.className = "standalone-check";
  check.checked = task.completed;
  check.addEventListener("change", (e) => {
    e.stopPropagation();
    toggleStandaloneTaskCompleted(task.id);
  });
  checkWrap.appendChild(check);
  card.appendChild(checkWrap);

  const title = document.createElement("span");
  title.className = "standalone-title";
  title.textContent = task.title;
  card.appendChild(title);

  if (task.time_of_day) {
    const time = document.createElement("span");
    time.className = "standalone-time";
    time.textContent = task.time_of_day;
    card.appendChild(time);
  }

  const delBtn = document.createElement("button");
  delBtn.type = "button";
  delBtn.className = "standalone-delete-x week";
  delBtn.textContent = "\u00d7";
  delBtn.title = "Delete task";
  delBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (confirm("Delete this task?")) deleteStandaloneTask(task.id);
  });
  card.appendChild(delBtn);

  // Intra-column reorder: dragover/drop on standalone card (accepts experiment & standalone drags)
  card.addEventListener("dragover", (e) => {
    const drag = readDragPayload(e.dataTransfer);
    if (!drag) return;
    if (drag.kind === "standalone" && drag.taskId && drag.taskId !== task.id) {
      // ok
    } else if (drag.kind === "task" && drag.taskId) {
      // ok — experiment task dropping onto standalone
    } else return;
    e.preventDefault();
    e.stopPropagation();
    card.classList.remove("drop-before", "drop-after");
    card.classList.add(e.offsetY < card.clientHeight / 2 ? "drop-before" : "drop-after");
  });
  card.addEventListener("dragleave", () => card.classList.remove("drop-before", "drop-after"));
  card.addEventListener("drop", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    card.classList.remove("drop-before", "drop-after");
    const drag = readDragPayload(e.dataTransfer);
    if (!drag) return;
    const insertBefore = e.offsetY < card.clientHeight / 2;
    const targetOrder = task.sort_order ?? 0;
    const newOrder = insertBefore ? targetOrder - 1 : targetOrder + 1;

    if (drag.kind === "standalone" && drag.taskId && drag.taskId !== task.id) {
      const body = { sort_order: newOrder };
      if (task.date) body.date = task.date;
      else body.date = null;
      await api(`/api/tasks/${drag.taskId}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      clearActiveDrag();
      await refreshAll();
    } else if (drag.kind === "task" && drag.taskId) {
      const dragExpId = resolveTaskExperimentId(drag.taskId, drag.experimentId);
      clearActiveDrag();
      await reorderTask(dragExpId, drag.taskId, newOrder);
    }
  });

  card.addEventListener("click", (e) => {
    if (e.target.closest(".standalone-check-wrap") || e.target.closest(".standalone-delete-x")) return;
    e.stopPropagation();
    state.expandedTaskId = task.id;
    drawMonthGrid();
    renderWeek({ skipFetch: true });
  });

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
  placementCandidate.draggable = !isTouchInteraction();
  $("#placement-subtitle").textContent = isTouchInteraction()
    ? `Start date ${state.placement.anchorDate}. Tap a date to reposition.`
    : `Start date ${state.placement.anchorDate}. Drag the candidate chip to reposition before creating the draft.`;
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
    label: ctx.task.step_name,
  };
  showMovePopover(toDate);

  // Single repaint
  drawMonthGrid();
  renderWeek({ skipFetch: true });
  return true;
}

function clearPendingMove() {
  state.pendingMove = null;
  dismissMovePopover();
  drawMonthGrid();
  renderWeek({ skipFetch: true });
}

async function commitPendingMove() {
  if (!state.pendingMove) return;
  const reasonInput = document.getElementById("move-popover-reason");
  const reason = (reasonInput?.value || "Manual deviation").trim();

  const res = await api(`/api/experiments/${state.pendingMove.experimentId}/tasks/move`, {
    method: "PATCH",
    body: JSON.stringify({
      task_id: state.pendingMove.taskId,
      new_date: state.pendingMove.toDate,
      reason,
    }),
  });

  if (res.error) {
    // Show error inline in the popover
    const popover = document.getElementById("move-popover");
    if (popover) {
      let errEl = popover.querySelector(".move-popover-error");
      if (!errEl) {
        errEl = document.createElement("div");
        errEl.className = "move-popover-error";
        popover.querySelector(".move-popover-actions")?.before(errEl);
      }
      errEl.textContent = res.error;
    }
    return;
  }

  showStatus("Move saved.");
  state.pendingMove = null;
  dismissMovePopover();
  await refreshAll();
}

/* ── Live drag preview ──────────────────────────────────────────── */

function previewDragMove(experimentId, taskId, cellDate) {
  const ctx = state.taskContext.get(taskId);
  if (!ctx) return;
  const resolvedExperimentId = resolveTaskExperimentId(taskId, experimentId);
  if (!resolvedExperimentId) return;

  // Same cell as current task position — clear any preview
  if (ctx.task.date === cellDate) {
    if (state.pendingMove?.preview) {
      state.pendingMove = null;
      drawMonthGrid();
    }
    return;
  }

  // Guard against redundant repaints when hovering the same cell
  if (
    state.pendingMove?.preview &&
    state.pendingMove.taskId === taskId &&
    state.pendingMove.toDate === cellDate
  ) {
    return;
  }

  // Constraint check
  if (ctx.parentDate && cellDate < ctx.parentDate) return;

  const deltaDays = diffDays(ctx.task.date, cellDate);
  const shiftedStepIds =
    deltaDays > 0
      ? computeShiftedStepIds(resolvedExperimentId, taskId)
      : new Set([ctx.task.step_id]);

  state.pendingMove = {
    experimentId: resolvedExperimentId,
    taskId,
    fromDate: ctx.task.date,
    toDate: cellDate,
    deltaDays,
    shiftedStepIds: Array.from(shiftedStepIds),
    label: ctx.task.step_name,
    preview: true,
  };

  drawMonthGrid();
}

/* ── Move popover (floating confirmation) ──────────────────────── */

function showMovePopover(targetDate) {
  dismissMovePopover();
  const pending = state.pendingMove;
  if (!pending) return;

  const deltaLabel = formatSignedDays(pending.deltaDays);
  const shiftCount = pending.shiftedStepIds.length;
  const downstreamCount = shiftCount > 1 ? shiftCount - 1 : 0;

  const popover = document.createElement("div");
  popover.className = "move-popover";
  popover.id = "move-popover";

  const ctx = state.taskContext.get(pending.taskId);
  const defaultReason = ctx?.task.deviation?.reason || `Manual deviation by ${deltaLabel}`;

  popover.innerHTML = `
    <div class="move-popover-header">${escapeHtml(pending.label)}</div>
    <div class="move-popover-delta">${pending.fromDate} &rarr; ${pending.toDate} (${deltaLabel})</div>
    ${downstreamCount > 0 ? `<div class="move-popover-downstream">${downstreamCount} downstream task${downstreamCount > 1 ? "s" : ""} shift</div>` : ""}
    <input id="move-popover-reason" class="move-popover-reason" value="${escapeHtml(defaultReason)}" />
    <div class="move-popover-actions">
      <button type="button" id="move-popover-confirm" class="btn primary">Confirm</button>
      <button type="button" id="move-popover-cancel" class="btn">Cancel</button>
    </div>
    <div class="move-popover-hint"><kbd>Enter</kbd> &middot; <kbd>Esc</kbd></div>
  `;

  document.body.appendChild(popover);

  popover.querySelector("#move-popover-confirm").addEventListener("click", async () => {
    await commitPendingMove();
  });

  popover.querySelector("#move-popover-cancel").addEventListener("click", () => {
    clearPendingMove();
  });

  const reasonInput = popover.querySelector("#move-popover-reason");
  reasonInput.addEventListener("keydown", async (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      await commitPendingMove();
    } else if (e.key === "Escape") {
      e.preventDefault();
      clearPendingMove();
    }
  });

  positionPopoverNearCell(popover, targetDate);

  // Auto-focus and select the reason input
  reasonInput.focus();
  reasonInput.select();

  // Bind outside-click handler after a tick to avoid catching the drop event
  setTimeout(() => {
    document.addEventListener("mousedown", handlePopoverOutsideClick);
    document.addEventListener("touchstart", handlePopoverOutsideClick);
  }, 0);
}

function positionPopoverNearCell(popover, targetDate) {
  // On mobile, CSS positions the popover as a bottom sheet
  if (window.innerWidth <= 480) return;

  // Find the matching cell in month or week view
  const cell =
    document.querySelector(`.month-cell[data-date="${targetDate}"]`) ||
    document.querySelector(`.week-day[data-date="${targetDate}"]`);

  if (!cell) {
    // Fallback: center on screen
    popover.style.left = "50%";
    popover.style.top = "50%";
    popover.style.transform = "translate(-50%, -50%)";
    return;
  }

  const rect = cell.getBoundingClientRect();
  const popoverRect = popover.getBoundingClientRect();

  // Position below the cell, horizontally centered on it
  let top = rect.bottom + 6;
  let left = rect.left + rect.width / 2 - popoverRect.width / 2;

  // Clamp to viewport
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  if (left < 8) left = 8;
  if (left + popoverRect.width > vw - 8) left = vw - 8 - popoverRect.width;
  if (top + popoverRect.height > vh - 8) {
    // Place above the cell instead
    top = rect.top - popoverRect.height - 6;
  }
  if (top < 8) top = 8;

  popover.style.left = `${left}px`;
  popover.style.top = `${top}px`;
}

function dismissMovePopover() {
  const popover = document.getElementById("move-popover");
  if (popover) popover.remove();
  document.removeEventListener("mousedown", handlePopoverOutsideClick);
  document.removeEventListener("touchstart", handlePopoverOutsideClick);
}

function handlePopoverOutsideClick(e) {
  const popover = document.getElementById("move-popover");
  if (!popover) {
    document.removeEventListener("mousedown", handlePopoverOutsideClick);
    document.removeEventListener("touchstart", handlePopoverOutsideClick);
    return;
  }
  if (!popover.contains(e.target)) {
    clearPendingMove();
  }
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

  const res = await api("/api/experiments", {
    method: "POST",
    body: JSON.stringify({
      protocol_id: state.placement.protocolId,
      start_date: state.placement.anchorDate,
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

function currentScientistName() {
  return state.username || "";
}

/* ── API / network ──────────────────────────────────────────────── */

async function api(url, opts = {}) {
  let res;
  try {
    res = await fetch(url, {
      headers: { "Content-Type": "application/json" },
      redirect: "follow",
      ...opts,
    });
  } catch (err) {
    // Network error or CORS failure from auth redirect
    window.location.reload();
    return { error: "Session expired — redirecting to login." };
  }

  // If redirected to auth page, the response will be HTML not JSON
  if (res.redirected || res.url.includes("auth.kmicinski.com")) {
    window.location.reload();
    return { error: "Session expired — redirecting to login." };
  }

  if (res.status === 401) {
    window.location.reload();
    return { error: "Session expired — redirecting to login." };
  }

  const text = await res.text();
  if (!text) return {};

  try {
    return JSON.parse(text);
  } catch {
    // Got HTML back (auth redirect page) instead of JSON
    if (text.includes("<!DOCTYPE") || text.includes("<html")) {
      window.location.reload();
      return { error: "Session expired — redirecting to login." };
    }
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

  if (payload.kind === "standalone") {
    dataTransfer.effectAllowed = "move";
    writeDragData(dataTransfer, "text/standalone-task-id", payload.taskId || "");
    writeDragData(dataTransfer, "text/plain", `scischedule:standalone:${payload.taskId || ""}`);
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

  const standaloneTaskId = safeGetData(dataTransfer, "text/standalone-task-id");
  if (standaloneTaskId) {
    return { kind: "standalone", taskId: standaloneTaskId };
  }

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
  if (plain.startsWith("scischedule:standalone:")) {
    const [, , saIdFromPlain] = plain.split(":");
    if (saIdFromPlain) {
      return { kind: "standalone", taskId: saIdFromPlain };
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
