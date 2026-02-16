const DEFAULT_MODEL = "gpt-4.1-mini";
const MAX_IMAGES = 30;

chrome.commands.onCommand.addListener((command) => {
  if (command !== "autofill-active-form") {
    return;
  }

  runAutoFillOnActiveTab().catch((error) => {
    console.error(
      "[Forms AutoFill] Keyboard shortcut failed:",
      error instanceof Error ? error.message : String(error)
    );
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

  const response = await chrome.tabs.sendMessage(activeTab.id, {
    type: "AUTO_FILL_FORM",
    customInstruction: ""
  });

  if (!response?.ok) {
    throw new Error(response?.error || "Auto-fill failed.");
  }
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
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${settings.apiKey}`
    },
    body: JSON.stringify({
      model: settings.model || DEFAULT_MODEL,
      temperature: 0.2,
      max_output_tokens: 800,
      input: [
        {
          role: "system",
          content: "You are a form-filling assistant. Output only JSON. Do not include markdown."
        },
        {
          role: "user",
          content: requestContent
        }
      ]
    })
  });

  if (!response.ok) {
    const errText = await safeText(response);
    throw new Error(`OpenAI API error ${response.status}: ${errText}`);
  }

  const data = await response.json();
  const text = extractOutputText(data);
  if (!text) {
    throw new Error("OpenAI returned an empty response.");
  }

  const parsed = parseJsonLoose(text);

  if (!parsed || !Array.isArray(parsed.answers)) {
    throw new Error("OpenAI response JSON must include an 'answers' array.");
  }

  return parsed;
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
  let count = 0;
  for (const question of questions) {
    count += normalizeStringArray(question?.questionImages).length;
    if (Array.isArray(question?.options)) {
      for (const option of question.options) {
        count += normalizeStringArray(option?.imageUrls).length;
      }
    }
  }
  return count;
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item) => typeof item === "string");
}

function extractOutputText(responseJson) {
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

async function getSettings() {
  const obj = await chrome.storage.sync.get({
    openaiApiKey: "",
    openaiModel: DEFAULT_MODEL
  });
  return {
    apiKey: (obj.openaiApiKey || "").trim(),
    model: (obj.openaiModel || DEFAULT_MODEL).trim()
  };
}

async function safeText(response) {
  try {
    return await response.text();
  } catch (_error) {
    return "Unable to read API error body.";
  }
}
