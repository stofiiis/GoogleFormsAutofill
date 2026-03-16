const DEFAULT_MODEL = "gpt-4.1-mini";
const MAX_IMAGES = 30;
const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const OPENAI_TIMEOUT_MS = 30000;
const OPENAI_MAX_RETRIES = 2;
const OPENAI_RETRY_BASE_DELAY_MS = 800;
const CONTENT_SCRIPT_FILES = ["content.js"];

const ANSWERS_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["answers"],
  properties: {
    answers: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["questionId", "answer"],
        properties: {
          questionId: { type: "string", minLength: 1 },
          answer: {
            anyOf: [
              { type: "string" },
              { type: "number" },
              { type: "null" },
              {
                type: "array",
                items: {
                  anyOf: [{ type: "string" }, { type: "number" }]
                }
              }
            ]
          }
        }
      }
    }
  }
};

chrome.commands.onCommand.addListener((command) => {
  if (command !== "autofill-active-form") {
    return;
  }

  runAutoFillOnActiveTab()
    .then(() => clearCommandBadge())
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[Forms AutoFill] Keyboard shortcut failed:", message);
      showCommandFailureBadge(message);
    });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || !message.type) {
    return;
  }

  if (message.type === "GENERATE_FORM_ANSWERS") {
    handleGenerateAnswers(message.payload)
      .then((result) => sendResponse({ ok: true, data: result }))
      .catch((error) => {
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        });
      });
    return true;
  }
});

async function runAutoFillOnActiveTab() {
  const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!activeTab?.id) {
    throw new Error("No active tab found.");
  }

  if (!isGoogleFormUrl(activeTab.url)) {
    throw new Error("Active tab is not a Google Form.");
  }

  const customInstruction = await getLastInstruction();
  const response = await sendMessageToFormTab(activeTab.id, {
    type: "AUTO_FILL_FORM",
    customInstruction
  });

  if (!response?.ok) {
    throw new Error(response?.error || "Auto-fill failed.");
  }
}

async function sendMessageToFormTab(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (error) {
    if (!shouldRetryAfterInject(error)) {
      throw error;
    }

    await chrome.scripting.executeScript({
      target: { tabId },
      files: CONTENT_SCRIPT_FILES
    });

    return chrome.tabs.sendMessage(tabId, message);
  }
}

function shouldRetryAfterInject(error) {
  const message = String(error?.message || "");
  return /receiving end does not exist|could not establish connection/i.test(message);
}

async function getLastInstruction() {
  const [localData, syncData] = await Promise.all([
    chrome.storage.local.get({ lastInstructionText: "" }),
    chrome.storage.sync.get({ lastInstructionText: "" })
  ]);

  const localInstruction = String(localData.lastInstructionText || "").trim();
  if (localInstruction) {
    return localInstruction;
  }

  const syncInstruction = String(syncData.lastInstructionText || "").trim();
  if (syncInstruction) {
    await chrome.storage.local.set({ lastInstructionText: syncInstruction });
  }
  return syncInstruction;
}

function isGoogleFormUrl(url) {
  return typeof url === "string" && /^https:\/\/docs\.google\.com\/forms\//i.test(url);
}

async function handleGenerateAnswers(payload) {
  const settings = await getSettings();
  if (!settings.apiKey) {
    throw new Error("Missing OpenAI API key. Open extension options and set it first.");
  }
  if (!payload || !Array.isArray(payload.questions) || payload.questions.length === 0) {
    throw new Error("No questions detected on the page.");
  }

  const requestContent = buildUserContent(payload);
  const requestPayload = {
    model: settings.model || DEFAULT_MODEL,
    temperature: 0.2,
    max_output_tokens: computeMaxOutputTokens(payload.questions.length),
    text: {
      format: {
        type: "json_schema",
        name: "form_answers",
        schema: ANSWERS_JSON_SCHEMA,
        strict: true
      }
    },
    input: [
      {
        role: "system",
        content: "You are a form-filling assistant. Return valid JSON that matches the provided schema."
      },
      {
        role: "user",
        content: requestContent
      }
    ]
  };
  const data = await requestOpenAIJson(requestPayload, settings.apiKey);
  const parsed = extractOutputJson(data);
  const validated = validateAndNormalizeAnswers(parsed, payload.questions);
  const rawModelText = extractOutputText(data) || safeJsonStringify(parsed);

  return {
    answers: validated.answers,
    validationIssues: validated.issues,
    rawModelText
  };
}

async function requestOpenAIJson(requestPayload, apiKey) {
  let lastError = null;
  for (let attempt = 0; attempt <= OPENAI_MAX_RETRIES; attempt += 1) {
    try {
      const response = await fetchWithTimeout(OPENAI_RESPONSES_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify(requestPayload)
      });

      if (response.ok) {
        return await response.json();
      }

      const errText = await safeText(response);
      const shouldRetry = isRetryableStatus(response.status) && attempt < OPENAI_MAX_RETRIES;
      if (!shouldRetry) {
        throw new Error(`OpenAI API error ${response.status}: ${errText}`);
      }

      lastError = new Error(`OpenAI temporary error ${response.status}: ${errText}`);
    } catch (error) {
      const asError = error instanceof Error ? error : new Error(String(error));
      if (!isRetryableError(asError) || attempt >= OPENAI_MAX_RETRIES) {
        throw asError;
      }
      lastError = asError;
    }

    await sleep(OPENAI_RETRY_BASE_DELAY_MS * (attempt + 1));
  }

  throw lastError || new Error("OpenAI request failed.");
}

async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error && error.name === "AbortError") {
      throw new Error(`OpenAI request timed out after ${Math.round(OPENAI_TIMEOUT_MS / 1000)}s.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function isRetryableStatus(status) {
  return status === 408 || status === 409 || status === 429 || (status >= 500 && status <= 599);
}

function isRetryableError(error) {
  const message = String(error?.message || "");
  return /timed out|network|failed to fetch|load failed/i.test(message);
}

function computeMaxOutputTokens(questionCount) {
  const count = Number.isFinite(Number(questionCount)) ? Number(questionCount) : 0;
  const computed = 500 + count * 90;
  return Math.min(2800, Math.max(900, computed));
}

function extractOutputJson(responseJson) {
  if (responseJson && typeof responseJson.output_parsed === "object" && responseJson.output_parsed) {
    return responseJson.output_parsed;
  }

  const text = extractOutputText(responseJson);
  if (!text) {
    throw new Error("OpenAI returned an empty response.");
  }
  return parseJsonLoose(text);
}

function buildUserContent(payload) {
  const { preparedQuestions, imageRegistry, omittedImagesCount } = prepareModelData(payload);
  const instruction = payload.customInstruction
    ? `Additional user instruction:\n${payload.customInstruction}\n\n`
    : "";
  const promptText = `${instruction}You will receive Google Form questions.
Return strict JSON in this exact structure:
{
  "answers": [
    { "questionId": "...", "answer": "..." },
    { "questionId": "...", "answer": 2 },
    { "questionId": "...", "answer": ["option A", "option B"] },
    { "questionId": "...", "answer": [1, 3] }
  ]
}

Rules:
- questionId must match provided IDs.
- Return exactly one answer object for every provided questionId (no skipping).
- For short text/paragraph, answer as string.
- If text answer is numeric, still return it as a string (e.g. "4").
- For multiple choice, prefer optionIndex number. Text is allowed only if index is unclear.
- If options are numeric labels (e.g. "2", "8"), return exact option text instead of optionIndex.
- For checkbox, prefer an array of optionIndex numbers.
- If checkbox options are numeric labels (e.g. "2", "8"), return exact option texts instead of option indexes.
- For checkbox, return only options you believe are correct.
- Do NOT select every checkbox option by default.
- Select all checkbox options only if you are confident that all options are correct.
- For dropdown, prefer optionIndex number. Text is allowed only if index is unclear.
- If dropdown options are numeric labels, return exact option text instead of optionIndex.
- For linear_scale, prefer numeric value from the scale (or optionIndex if needed).
- optionIndex is 1-based.
- For options select the single best answer. Do not return multiple options unless it's a checkbox question and you are confident multiple are correct.
- For any question that has questionImageIds, analyze those images first and base the answer on them.
- If options contain imageIds, compare option images and select by optionIndex according to image content.
- If text and image conflict, prioritize image evidence.
- If unsure, still provide a best effort answer.
- Keep output strictly valid JSON, no markdown.
${omittedImagesCount > 0 ? `- Only the first ${MAX_IMAGES} images were attached.\n` : ""}

Image registry (attached in this same order):
${JSON.stringify(
  imageRegistry.map((img) => ({ imageId: img.imageId, url: img.url })),
  null,
  2
)}

Questions:
${JSON.stringify(preparedQuestions, null, 2)}`;

  const content = [{ type: "input_text", text: promptText }];
  for (const image of imageRegistry) {
    content.push({
      type: "input_image",
      image_url: image.url
    });
  }
  return content;
}

function prepareModelData(payload) {
  const imageByUrl = new Map();
  const imageRegistry = [];

  const registerImage = (url) => {
    const cleanUrl = String(url || "").trim();
    if (!cleanUrl || !/^https?:\/\//i.test(cleanUrl)) {
      return null;
    }
    if (imageByUrl.has(cleanUrl)) {
      return imageByUrl.get(cleanUrl);
    }
    if (imageRegistry.length >= MAX_IMAGES) {
      return null;
    }
    const imageId = `img_${imageRegistry.length + 1}`;
    imageRegistry.push({ imageId, url: cleanUrl });
    imageByUrl.set(cleanUrl, imageId);
    return imageId;
  };

  const preparedQuestions = payload.questions.map((question) => {
    const questionImageIds = normalizeStringArray(question.questionImages)
      .map((url) => registerImage(url))
      .filter(Boolean);

    const options = Array.isArray(question.options)
      ? question.options.map((option, idx) => ({
          optionIndex: normalizeOptionIndex(option.optionIndex, idx + 1),
          text: String(option.text || ""),
          imageIds: normalizeStringArray(option.imageUrls)
            .map((url) => registerImage(url))
            .filter(Boolean)
        }))
      : [];

    return {
      questionId: String(question.questionId || ""),
      questionText: String(question.questionText || ""),
      type: String(question.type || ""),
      questionImageIds,
      options
    };
  });

  const allImageUrlsCount = countAllImageUrls(payload.questions);
  const omittedImagesCount = Math.max(0, allImageUrlsCount - imageRegistry.length);
  return { preparedQuestions, imageRegistry, omittedImagesCount };
}

function normalizeOptionIndex(value, fallback) {
  const number = Number(value);
  if (Number.isInteger(number) && number > 0) {
    return number;
  }
  return fallback;
}

function countAllImageUrls(questions) {
  const uniqueUrls = new Set();
  for (const question of questions) {
    for (const url of normalizeStringArray(question?.questionImages)) {
      const cleanUrl = String(url || "").trim();
      if (/^https?:\/\//i.test(cleanUrl)) {
        uniqueUrls.add(cleanUrl);
      }
    }

    if (Array.isArray(question?.options)) {
      for (const option of question.options) {
        for (const url of normalizeStringArray(option?.imageUrls)) {
          const cleanUrl = String(url || "").trim();
          if (/^https?:\/\//i.test(cleanUrl)) {
            uniqueUrls.add(cleanUrl);
          }
        }
      }
    }
  }
  return uniqueUrls.size;
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item) => typeof item === "string");
}

function extractOutputText(responseJson) {
  if (typeof responseJson?.output_text === "string" && responseJson.output_text.trim()) {
    return responseJson.output_text.trim();
  }
  if (!responseJson || !Array.isArray(responseJson.output)) {
    return "";
  }
  const parts = [];
  for (const item of responseJson.output) {
    if (!item || !Array.isArray(item.content)) {
      continue;
    }
    for (const content of item.content) {
      if (content && content.type === "output_text" && typeof content.text === "string") {
        parts.push(content.text);
      }
    }
  }
  return parts.join("\n").trim();
}

function parseJsonLoose(text) {
  try {
    return JSON.parse(text);
  } catch (_error) {
    // continue
  }

  const fencedMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fencedMatch?.[1]) {
    try {
      return JSON.parse(fencedMatch[1]);
    } catch (_error) {
      // continue
    }
  }

  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    const maybeJson = text.slice(firstBrace, lastBrace + 1);
    try {
      return JSON.parse(maybeJson);
    } catch (_error) {
      // continue
    }
  }

  throw new Error("OpenAI response was not valid JSON.");
}

function validateAndNormalizeAnswers(parsed, questions) {
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.answers)) {
    throw new Error("OpenAI response JSON must include an 'answers' array.");
  }

  const issues = [];
  const questionById = new Map();
  for (const question of questions || []) {
    const questionId = String(question?.questionId || "").trim();
    if (questionId) {
      questionById.set(questionId, question);
    }
  }

  const seenQuestionIds = new Set();
  const normalizedAnswers = [];

  for (const item of parsed.answers) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      issues.push("Skipped answer item because it is not an object.");
      continue;
    }

    const questionId = String(item.questionId || "").trim();
    if (!questionId) {
      issues.push("Skipped answer item without questionId.");
      continue;
    }
    if (!questionById.has(questionId)) {
      issues.push(`Skipped answer for unknown questionId '${questionId}'.`);
      continue;
    }
    if (seenQuestionIds.has(questionId)) {
      issues.push(`Duplicate answer for '${questionId}' ignored (kept first).`);
      continue;
    }

    const normalized = normalizeAnswerForQuestion(item.answer, questionById.get(questionId));
    if (!normalized.ok) {
      issues.push(`questionId '${questionId}': ${normalized.reason}`);
    }

    normalizedAnswers.push({
      questionId,
      answer: normalized.value
    });
    seenQuestionIds.add(questionId);
  }

  for (const questionId of questionById.keys()) {
    if (!seenQuestionIds.has(questionId)) {
      normalizedAnswers.push({ questionId, answer: null });
      issues.push(`questionId '${questionId}' missing in model output, inserted null.`);
    }
  }

  if (!normalizedAnswers.length) {
    throw new Error("OpenAI response did not include any usable answers.");
  }

  return { answers: normalizedAnswers, issues };
}

function normalizeAnswerForQuestion(answer, question) {
  const questionType = String(question?.type || "").trim().toLowerCase();

  if (answer === null || answer === undefined) {
    return { ok: true, value: null, reason: "answer is null" };
  }

  if (questionType === "text" || questionType === "paragraph") {
    const text = normalizeTextAnswer(answer);
    if (!text) {
      return { ok: false, value: null, reason: "text answer is empty." };
    }
    return { ok: true, value: text };
  }

  if (questionType === "checkbox") {
    const normalizedCheckbox = normalizeCheckboxAnswer(answer);
    if (!normalizedCheckbox.length) {
      return { ok: false, value: [], reason: "checkbox answer has no valid targets." };
    }
    return { ok: true, value: normalizedCheckbox };
  }

  if (questionType === "multiple_choice" || questionType === "dropdown" || questionType === "linear_scale") {
    const single = normalizeSingleChoiceAnswer(answer);
    if (single === null || single === "") {
      return { ok: false, value: null, reason: "single-choice answer is empty." };
    }
    return { ok: true, value: single };
  }

  return { ok: true, value: answer };
}

function normalizeTextAnswer(answer) {
  if (answer === null || answer === undefined) {
    return "";
  }
  if (
    typeof answer === "string" ||
    typeof answer === "number" ||
    typeof answer === "boolean" ||
    typeof answer === "bigint"
  ) {
    return String(answer).trim();
  }
  if (Array.isArray(answer)) {
    const first = answer.map((item) => normalizeTextAnswer(item)).find((item) => item);
    return first || "";
  }
  if (typeof answer === "object") {
    return (
      normalizeTextAnswer(answer.answer) ||
      normalizeTextAnswer(answer.text) ||
      normalizeTextAnswer(answer.value) ||
      normalizeTextAnswer(answer.response)
    );
  }
  return "";
}

function normalizeSingleChoiceAnswer(answer) {
  if (answer === null || answer === undefined) {
    return null;
  }
  if (typeof answer === "string") {
    return answer.trim();
  }
  if (typeof answer === "number") {
    return answer;
  }
  if (Array.isArray(answer)) {
    if (!answer.length) {
      return null;
    }
    return normalizeSingleChoiceAnswer(answer[0]);
  }
  if (typeof answer === "object") {
    if (answer.optionIndex !== undefined) {
      return normalizeSingleChoiceAnswer(answer.optionIndex);
    }
    if (answer.answer !== undefined) {
      return normalizeSingleChoiceAnswer(answer.answer);
    }
    if (answer.text !== undefined) {
      return normalizeSingleChoiceAnswer(answer.text);
    }
    if (answer.value !== undefined) {
      return normalizeSingleChoiceAnswer(answer.value);
    }
    if (answer.response !== undefined) {
      return normalizeSingleChoiceAnswer(answer.response);
    }
  }
  return null;
}

function normalizeCheckboxAnswer(answer) {
  if (answer === null || answer === undefined) {
    return [];
  }
  if (Array.isArray(answer)) {
    return answer.map((item) => normalizeSingleChoiceAnswer(item)).filter((item) => item !== null && item !== "");
  }
  if (typeof answer === "object") {
    if (Array.isArray(answer.answer)) {
      return normalizeCheckboxAnswer(answer.answer);
    }
    if (Array.isArray(answer.optionIndexes)) {
      return normalizeCheckboxAnswer(answer.optionIndexes);
    }
    if (Array.isArray(answer.options)) {
      return normalizeCheckboxAnswer(answer.options);
    }
    if (answer.answer !== undefined) {
      return normalizeCheckboxAnswer([answer.answer]);
    }
    if (answer.value !== undefined) {
      return normalizeCheckboxAnswer([answer.value]);
    }
    if (answer.response !== undefined) {
      return normalizeCheckboxAnswer([answer.response]);
    }
  }

  const single = normalizeSingleChoiceAnswer(answer);
  return single === null || single === "" ? [] : [single];
}

async function getSettings() {
  const obj = await chrome.storage.sync.get({
    openaiApiKey: "",
    openaiModel: DEFAULT_MODEL
  });
  const model = String(obj.openaiModel || DEFAULT_MODEL).trim();
  if (!model || /\s/.test(model) || model.length > 120) {
    throw new Error("Configured model name is invalid. Use a valid OpenAI model id in Settings.");
  }
  return {
    apiKey: (obj.openaiApiKey || "").trim(),
    model
  };
}

async function safeText(response) {
  try {
    return await response.text();
  } catch (_error) {
    return "Unable to read API error body.";
  }
}

function safeJsonStringify(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch (_error) {
    return "";
  }
}

async function showCommandFailureBadge(message) {
  await Promise.allSettled([
    chrome.action.setBadgeText({ text: "!" }),
    chrome.action.setBadgeBackgroundColor({ color: "#991b1b" }),
    chrome.action.setTitle({ title: `Forms AutoFill: ${String(message || "shortcut failed")}` })
  ]);
}

async function clearCommandBadge() {
  await Promise.allSettled([
    chrome.action.setBadgeText({ text: "" }),
    chrome.action.setTitle({ title: "Forms AutoFill" })
  ]);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
