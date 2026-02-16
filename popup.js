const fillButton = document.getElementById("fillButton");
const statusEl = document.getElementById("status");
const instructionEl = document.getElementById("instruction");

fillButton.addEventListener("click", async () => {
  setStatus("Working...", false);
  fillButton.disabled = true;

  try {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!activeTab?.id) {
      throw new Error("No active tab found.");
    }

    if (!activeTab.url?.startsWith("https://docs.google.com/forms/")) {
      throw new Error("Active tab is not a Google Form.");
    }

    const response = await chrome.tabs.sendMessage(activeTab.id, {
      type: "AUTO_FILL_FORM",
      customInstruction: instructionEl.value.trim()
    });

    if (!response?.ok) {
      throw new Error(response?.error || "Auto-fill failed.");
    }

    const data = response.data || {};
    setStatus(
      `Done. Filled ${data.answersApplied || 0} of ${data.totalQuestions || 0} questions.`,
      false
    );
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), true);
  } finally {
    fillButton.disabled = false;
  }
});

function setStatus(message, isError) {
  statusEl.textContent = message;
  statusEl.className = isError ? "error" : "success";
}
