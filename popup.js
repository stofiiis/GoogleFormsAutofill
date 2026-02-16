const fillButton = document.getElementById("fillButton");
const applyButton = document.getElementById("applyButton");
const statusEl = document.getElementById("status");
const instructionEl = document.getElementById("instruction");
const previewModeEl = document.getElementById("previewMode");
const previewSectionEl = document.getElementById("previewSection");
const previewListEl = document.getElementById("previewList");
const debugRawEl = document.getElementById("debugRaw");
const debugMappingEl = document.getElementById("debugMapping");

let lastPreview = null;

updateFillButtonLabel();

previewModeEl.addEventListener("change", () => {
  updateFillButtonLabel();
  resetPreview();
});

instructionEl.addEventListener("input", () => {
  if (lastPreview) {
    resetPreview();
    setStatus("Instruction changed. Analyze again to refresh preview.", false);
  }
});

previewListEl.addEventListener("change", () => {
  applyButton.disabled = !hasSelectedPreviewItems();
});

fillButton.addEventListener("click", async () => {
  setStatus("Working...", false);
  setWorking(true);
  try {
    const activeTab = await getActiveGoogleFormTab();
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
  renderPreview(lastPreview.previewItems);
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

  return {
    tabId,
    totalQuestions: Number(data?.totalQuestions || 0),
    applicableAnswers: Number(data?.applicableAnswers || 0),
    previewItems,
    answers,
    validationIssues,
    rawModelText: String(data?.rawModelText || "")
  };
}

function renderPreview(items) {
  previewListEl.innerHTML = "";
  previewSectionEl.hidden = false;

  for (const item of items) {
    const row = document.createElement("label");
    row.className = "preview-item";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "preview-check";
    checkbox.dataset.questionId = String(item.questionId || "");
    checkbox.checked = Boolean(item.canApply);
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
  if (!applyButton.hidden) {
    applyButton.disabled = isWorking || !hasSelectedPreviewItems();
  }
}

function updateFillButtonLabel() {
  fillButton.textContent = previewModeEl.checked ? "Analyze (Preview)" : "Analyze and Fill";
}

function setStatus(message, isError) {
  statusEl.textContent = message;
  statusEl.className = isError ? "error" : "success";
}
