const DEFAULT_MODEL = "gpt-4.1-mini";

const apiKeyEl = document.getElementById("apiKey");
const modelEl = document.getElementById("model");
const saveButton = document.getElementById("saveButton");
const statusEl = document.getElementById("status");

initialize().catch((error) => {
  setStatus(error instanceof Error ? error.message : String(error), true);
});

saveButton.addEventListener("click", async () => {
  try {
    const apiKey = apiKeyEl.value.trim();
    const model = modelEl.value.trim() || DEFAULT_MODEL;
    await chrome.storage.sync.set({
      openaiApiKey: apiKey,
      openaiModel: model
    });
    setStatus("Saved.", false);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), true);
  }
});

async function initialize() {
  const data = await chrome.storage.sync.get({
    openaiApiKey: "",
    openaiModel: DEFAULT_MODEL
  });
  apiKeyEl.value = data.openaiApiKey || "";
  modelEl.value = data.openaiModel || DEFAULT_MODEL;
}

function setStatus(message, isError) {
  statusEl.textContent = message;
  statusEl.className = isError ? "error" : "success";
}
