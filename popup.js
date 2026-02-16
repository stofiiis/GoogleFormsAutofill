const fillButton = document.getElementById("fillButton");
const applyButton = document.getElementById("applyButton");
const statusEl = document.getElementById("status");
const instructionEl = document.getElementById("instruction");
const previewModeEl = document.getElementById("previewMode");
const previewSectionEl = document.getElementById("previewSection");
const previewListEl = document.getElementById("previewList");
const debugRawEl = document.getElementById("debugRaw");
const debugMappingEl = document.getElementById("debugMapping");
const templateSelectEl = document.getElementById("templateSelect");
const templateNameEl = document.getElementById("templateName");
const saveTemplateButton = document.getElementById("saveTemplateButton");
const deleteTemplateButton = document.getElementById("deleteTemplateButton");

const BUILTIN_TEMPLATE_ID = "builtin:none";
const BUILTIN_TEMPLATES = [
  { id: BUILTIN_TEMPLATE_ID, name: "No template", text: "" },
  {
    id: "builtin:student",
    name: "Student",
    text: "Answer as a diligent student. Keep answers clear, direct, and exam-oriented."
  },
  {
    id: "builtin:brief",
    name: "Brief",
    text: "Answer briefly. Prefer the shortest correct choice or wording."
  },
  {
    id: "builtin:formal",
    name: "Formal",
    text: "Answer in a formal and professional tone."
  },
  {
    id: "builtin:expert",
    name: "Expert",
    text: "Answer as a domain expert using precise terminology and high factual accuracy."
  }
];

let lastPreview = null;
let customTemplates = [];
let selectedTemplateId = BUILTIN_TEMPLATE_ID;
let persistTimer = null;

initialize().catch((error) => {
  setStatus(error instanceof Error ? error.message : String(error), true);
});

previewModeEl.addEventListener("change", () => {
  updateFillButtonLabel();
  resetPreview();
});

templateSelectEl.addEventListener("change", async () => {
  try {
    await applySelectedTemplate();
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), true);
  }
});

saveTemplateButton.addEventListener("click", async () => {
  try {
    await saveCurrentAsTemplate();
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), true);
  }
});

deleteTemplateButton.addEventListener("click", async () => {
  try {
    await deleteSelectedTemplate();
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), true);
  }
});

instructionEl.addEventListener("input", () => {
  if (lastPreview) {
    resetPreview();
    setStatus("Instruction changed. Analyze again to refresh preview.", false);
  }
  schedulePersistTemplateState();
});

previewListEl.addEventListener("change", () => {
  applyButton.disabled = !hasSelectedPreviewItems();
});

fillButton.addEventListener("click", async () => {
  setStatus("Working...", false);
  setWorking(true);
  try {
    const activeTab = await getActiveGoogleFormTab();
    await persistTemplateState();
    if (previewModeEl.checked) {
      await runPreview(activeTab.id);
    } else {
      resetPreview();
      await runDirectFill(activeTab.id);
    }
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), true);
  } finally {
    setWorking(false);
  }
});

applyButton.addEventListener("click", async () => {
  setStatus("Applying selected answers...", false);
  setWorking(true);
  try {
    if (!lastPreview) {
      throw new Error("No preview data available. Analyze first.");
    }
    const activeTab = await getActiveGoogleFormTab();
    if (activeTab.id !== lastPreview.tabId) {
      throw new Error("Active tab changed. Analyze again.");
    }

    const selectedAnswers = getSelectedAnswers();
    if (!selectedAnswers.length) {
      throw new Error("No preview items selected.");
    }

    const response = await chrome.tabs.sendMessage(activeTab.id, {
      type: "APPLY_FORM_ANSWERS",
      answers: selectedAnswers
    });
    if (!response?.ok) {
      throw new Error(response?.error || "Applying selected answers failed.");
    }

    const data = response.data || {};
    setStatus(
      `Done. Applied ${data.answersApplied || 0} of ${data.selectedQuestions || 0} selected answers.`,
      false
    );
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), true);
  } finally {
    setWorking(false);
  }
});

async function initialize() {
  updateFillButtonLabel();
  await loadTemplateState();
  updateTemplateButtons();
}

async function loadTemplateState() {
  const data = await chrome.storage.sync.get({
    instructionTemplates: [],
    selectedInstructionTemplateId: BUILTIN_TEMPLATE_ID,
    lastInstructionText: ""
  });

  customTemplates = normalizeCustomTemplates(data.instructionTemplates);
  selectedTemplateId = resolveTemplateId(data.selectedInstructionTemplateId);
  renderTemplateOptions();

  const selectedTemplate = getTemplateById(selectedTemplateId);
  const savedInstruction = String(data.lastInstructionText || "");
  instructionEl.value = savedInstruction || selectedTemplate?.text || "";
  templateSelectEl.value = selectedTemplateId;
}

function normalizeCustomTemplates(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item, index) => ({
      id: normalizeCustomTemplateId(item?.id, index),
      name: String(item?.name || "").trim(),
      text: String(item?.text || "").trim()
    }))
    .filter((item) => item.name && item.text);
}

function normalizeCustomTemplateId(id, index) {
  const raw = String(id || "").trim();
  if (raw.startsWith("custom:")) {
    return raw;
  }
  return `custom:${Date.now()}-${index + 1}`;
}

function getAllTemplates() {
  return [...BUILTIN_TEMPLATES, ...customTemplates];
}

function getTemplateById(templateId) {
  return getAllTemplates().find((template) => template.id === templateId) || null;
}

function resolveTemplateId(templateId) {
  const candidate = String(templateId || "").trim();
  return getTemplateById(candidate) ? candidate : BUILTIN_TEMPLATE_ID;
}

function isCustomTemplateId(templateId) {
  return String(templateId || "").startsWith("custom:");
}

function renderTemplateOptions() {
  templateSelectEl.innerHTML = "";

  const builtinGroup = document.createElement("optgroup");
  builtinGroup.label = "Built-in";
  for (const template of BUILTIN_TEMPLATES) {
    const option = document.createElement("option");
    option.value = template.id;
    option.textContent = template.name;
    builtinGroup.appendChild(option);
  }
  templateSelectEl.appendChild(builtinGroup);

  if (customTemplates.length > 0) {
    const customGroup = document.createElement("optgroup");
    customGroup.label = "Custom";
    for (const template of customTemplates) {
      const option = document.createElement("option");
      option.value = template.id;
      option.textContent = template.name;
      customGroup.appendChild(option);
    }
    templateSelectEl.appendChild(customGroup);
  }

  templateSelectEl.value = resolveTemplateId(selectedTemplateId);
}

async function applySelectedTemplate() {
  selectedTemplateId = resolveTemplateId(templateSelectEl.value);
  templateSelectEl.value = selectedTemplateId;
  const template = getTemplateById(selectedTemplateId);
  instructionEl.value = template?.text || "";
  updateTemplateButtons();
  resetPreview();
  await persistTemplateState();
  setStatus(`Template '${template?.name || "No template"}' loaded.`, false);
}

async function saveCurrentAsTemplate() {
  const name = String(templateNameEl.value || "").trim();
  const text = String(instructionEl.value || "").trim();

  if (!name) {
    throw new Error("Enter a custom template name first.");
  }
  if (!text) {
    throw new Error("Instruction text is empty.");
  }

  const existing = customTemplates.find(
    (template) => template.name.toLowerCase() === name.toLowerCase()
  );

  if (existing) {
    existing.name = name;
    existing.text = text;
    selectedTemplateId = existing.id;
    setStatus(`Template '${name}' updated.`, false);
  } else {
    const newTemplate = {
      id: `custom:${Date.now()}`,
      name,
      text
    };
    customTemplates.push(newTemplate);
    selectedTemplateId = newTemplate.id;
    setStatus(`Template '${name}' saved.`, false);
  }

  renderTemplateOptions();
  templateSelectEl.value = selectedTemplateId;
  templateNameEl.value = "";
  updateTemplateButtons();
  await persistTemplateState();
}

async function deleteSelectedTemplate() {
  if (!isCustomTemplateId(selectedTemplateId)) {
    throw new Error("Select a custom template to delete.");
  }

  customTemplates = customTemplates.filter((template) => template.id !== selectedTemplateId);
  selectedTemplateId = BUILTIN_TEMPLATE_ID;
  renderTemplateOptions();
  templateSelectEl.value = selectedTemplateId;
  instructionEl.value = getTemplateById(selectedTemplateId)?.text || "";
  updateTemplateButtons();
  resetPreview();
  await persistTemplateState();
  setStatus("Custom template deleted.", false);
}

function updateTemplateButtons() {
  const isCustom = isCustomTemplateId(selectedTemplateId);
  deleteTemplateButton.hidden = !isCustom;
  deleteTemplateButton.disabled = !isCustom;
}

function schedulePersistTemplateState() {
  if (persistTimer) {
    clearTimeout(persistTimer);
  }
  persistTimer = setTimeout(() => {
    persistTemplateState().catch(() => {
      // ignore storage write issues in background updates
    });
  }, 150);
}

async function persistTemplateState() {
  await chrome.storage.sync.set({
    instructionTemplates: customTemplates,
    selectedInstructionTemplateId: selectedTemplateId,
    lastInstructionText: instructionEl.value
  });
}

async function getActiveGoogleFormTab() {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!activeTab?.id) {
    throw new Error("No active tab found.");
  }
  if (!activeTab.url?.startsWith("https://docs.google.com/forms/")) {
    throw new Error("Active tab is not a Google Form.");
  }
  return activeTab;
}

async function runDirectFill(tabId) {
  const response = await chrome.tabs.sendMessage(tabId, {
    type: "AUTO_FILL_FORM",
    customInstruction: instructionEl.value.trim()
  });
  if (!response?.ok) {
    throw new Error(response?.error || "Auto-fill failed.");
  }

  const data = response.data || {};
  setStatus(`Done. Filled ${data.answersApplied || 0} of ${data.totalQuestions || 0} questions.`, false);
}

async function runPreview(tabId) {
  const response = await chrome.tabs.sendMessage(tabId, {
    type: "PREVIEW_FORM_ANSWERS",
    customInstruction: instructionEl.value.trim()
  });
  if (!response?.ok) {
    throw new Error(response?.error || "Preview failed.");
  }

  lastPreview = normalizePreviewData(response.data, tabId);
  renderPreview(lastPreview);
  renderDebug(lastPreview);
  applyButton.hidden = false;
  applyButton.disabled = !hasSelectedPreviewItems();

  setStatus(
    `Preview ready. ${lastPreview.applicableAnswers} of ${lastPreview.totalQuestions} answers can be applied.`,
    false
  );
}

function normalizePreviewData(data, tabId) {
  const previewItems = Array.isArray(data?.previewItems) ? data.previewItems : [];
  const answers = Array.isArray(data?.answers) ? data.answers : [];
  const validationIssues = Array.isArray(data?.validationIssues) ? data.validationIssues : [];
  const validationByQuestionId = groupValidationIssuesByQuestionId(validationIssues);

  return {
    tabId,
    totalQuestions: Number(data?.totalQuestions || 0),
    applicableAnswers: Number(data?.applicableAnswers || 0),
    previewItems,
    answers,
    validationIssues,
    validationByQuestionId,
    rawModelText: String(data?.rawModelText || "")
  };
}

function renderPreview(preview) {
  const items = preview.previewItems || [];
  const issuesByQuestionId = preview.validationByQuestionId || new Map();
  previewListEl.innerHTML = "";
  previewSectionEl.hidden = false;

  for (const item of items) {
    const riskIssues = issuesByQuestionId.get(String(item.questionId || "")) || [];
    const isRisk = riskIssues.length > 0;
    const row = document.createElement("label");
    row.className = `preview-item${isRisk ? " risk" : ""}`;

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "preview-check";
    checkbox.dataset.questionId = String(item.questionId || "");
    checkbox.checked = Boolean(item.canApply) && !isRisk;
    checkbox.disabled = !item.canApply;

    const content = document.createElement("div");
    content.className = "preview-content";

    const title = document.createElement("div");
    title.className = "preview-title";
    title.textContent = String(item.questionText || item.questionId || "Question");

    const answer = document.createElement("div");
    answer.className = "preview-answer";
    answer.textContent = item.answerPreview
      ? `Answer: ${item.answerPreview}`
      : `Answer: ${String(item.rawAnswer ?? "") || "(empty)"}`;

    const reason = document.createElement("div");
    reason.className = item.canApply ? "preview-reason success" : "preview-reason error";
    reason.textContent = String(item.reason || "");

    content.appendChild(title);
    content.appendChild(answer);
    content.appendChild(reason);
    if (isRisk) {
      const risk = document.createElement("div");
      risk.className = "preview-risk";
      risk.textContent = `Risk: ${riskIssues.join(" | ")}`;
      content.appendChild(risk);
    }
    row.appendChild(checkbox);
    row.appendChild(content);
    previewListEl.appendChild(row);
  }
}

function renderDebug(preview) {
  debugRawEl.textContent = preview.rawModelText || "(empty)";
  debugMappingEl.textContent = JSON.stringify(
    {
      validationIssues: preview.validationIssues,
      previewItems: preview.previewItems
    },
    null,
    2
  );
}

function getSelectedAnswers() {
  if (!lastPreview) {
    return [];
  }

  const selectedIds = new Set(
    Array.from(previewListEl.querySelectorAll(".preview-check:checked"))
      .map((el) => String(el.dataset.questionId || "").trim())
      .filter(Boolean)
  );

  return lastPreview.answers.filter((answer) => selectedIds.has(String(answer?.questionId || "").trim()));
}

function hasSelectedPreviewItems() {
  return Boolean(previewListEl.querySelector(".preview-check:checked"));
}

function resetPreview() {
  lastPreview = null;
  previewListEl.innerHTML = "";
  previewSectionEl.hidden = true;
  applyButton.hidden = true;
  applyButton.disabled = true;
  debugRawEl.textContent = "";
  debugMappingEl.textContent = "";
}

function setWorking(isWorking) {
  fillButton.disabled = isWorking;
  previewModeEl.disabled = isWorking;
  templateSelectEl.disabled = isWorking;
  templateNameEl.disabled = isWorking;
  saveTemplateButton.disabled = isWorking;
  instructionEl.disabled = isWorking;
  deleteTemplateButton.disabled = isWorking || !isCustomTemplateId(selectedTemplateId);
  if (!applyButton.hidden) {
    applyButton.disabled = isWorking || !hasSelectedPreviewItems();
  }
}

function updateFillButtonLabel() {
  fillButton.textContent = previewModeEl.checked ? "Analyze (Preview)" : "Analyze and Fill";
}

function groupValidationIssuesByQuestionId(issues) {
  const byQuestionId = new Map();
  for (const rawIssue of issues || []) {
    const issue = String(rawIssue || "").trim();
    if (!issue) {
      continue;
    }
    const match = issue.match(/questionId\s+['"]([^'"]+)['"]/i);
    if (!match?.[1]) {
      continue;
    }
    const questionId = String(match[1]).trim();
    if (!questionId) {
      continue;
    }
    if (!byQuestionId.has(questionId)) {
      byQuestionId.set(questionId, []);
    }
    byQuestionId.get(questionId).push(issue);
  }
  return byQuestionId;
}

function setStatus(message, isError) {
  statusEl.textContent = message;
  statusEl.className = isError ? "error" : "success";
}
