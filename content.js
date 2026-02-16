chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== "AUTO_FILL_FORM") {
    return;
  }

  autoFillForm(message.customInstruction || "")
    .then((result) => sendResponse({ ok: true, data: result }))
    .catch((error) =>
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      })
    );

  return true;
});

async function autoFillForm(customInstruction) {
  const questions = await collectQuestions();
  if (!questions.length) {
    throw new Error("No supported questions found. Open a Google Form and try again.");
  }

  const aiResponse = await chrome.runtime.sendMessage({
    type: "GENERATE_FORM_ANSWERS",
    payload: {
      customInstruction,
      questions: questions.map((q) => ({
        questionId: q.id,
        questionText: q.text,
        type: q.type,
        questionImages: q.imageUrls,
        options: q.options
      }))
    }
  });

  if (!aiResponse || !aiResponse.ok) {
    throw new Error(aiResponse?.error || "Failed to generate answers.");
  }

  const applied = await applyAnswers(questions, aiResponse.data.answers || []);
  return {
    totalQuestions: questions.length,
    answersApplied: applied
  };
}

async function collectQuestions() {
  const listItems = document.querySelectorAll('[role="listitem"]');
  const results = [];
  let pendingContextText = "";
  let pendingContextImages = [];

  for (const item of listItems) {
    const questionText = getQuestionText(item);
    const itemImages = extractImageUrls(item);

    const textInput = item.querySelector('input[type="text"]:not([aria-label="Search"])');
    const textarea = item.querySelector("textarea");
    const dropdownControl = findDropdownControl(item);
    const radioButtons = Array.from(item.querySelectorAll('[role="radio"]')).filter((control) =>
      isSelectableControl(control)
    );
    const checkboxes = Array.from(item.querySelectorAll('[role="checkbox"]')).filter((control) =>
      isSelectableControl(control)
    );
    const isInteractive =
      Boolean(textInput || textarea || dropdownControl) || radioButtons.length > 0 || checkboxes.length > 0;

    if (!isInteractive) {
      if (questionText) {
        pendingContextText = questionText;
      }
      if (itemImages.length > 0) {
        pendingContextImages = mergeImageUrls(pendingContextImages, itemImages);
      }
      continue;
    }

    const questionImages = mergeImageUrls(itemImages, pendingContextImages);
    const finalQuestionText = composeQuestionText(questionText, pendingContextText, results.length + 1);
    const questionId = createQuestionId(finalQuestionText, results.length);
    pendingContextText = "";
    pendingContextImages = [];

    if (textInput) {
      results.push({
        id: questionId,
        text: finalQuestionText,
        type: "text",
        element: textInput,
        options: [],
        imageUrls: questionImages
      });
      continue;
    }

    if (textarea) {
      results.push({
        id: questionId,
        text: finalQuestionText,
        type: "paragraph",
        element: textarea,
        options: [],
        imageUrls: questionImages
      });
      continue;
    }

    if (dropdownControl) {
      const options = await collectDropdownOptions(dropdownControl);
      results.push({
        id: questionId,
        text: finalQuestionText,
        type: "dropdown",
        element: dropdownControl,
        options,
        imageUrls: questionImages
      });
      continue;
    }

    if (radioButtons.length) {
      const options = radioButtons.map((control, index) => ({
        optionIndex: index + 1,
        text: getControlLabel(control),
        imageUrls: extractImageUrls(getControlContainer(control))
      }));
      const type = looksLikeLinearScale(options, radioButtons) ? "linear_scale" : "multiple_choice";
      results.push({
        id: questionId,
        text: finalQuestionText,
        type,
        element: item,
        controls: radioButtons,
        options,
        imageUrls: questionImages
      });
      continue;
    }

    if (checkboxes.length) {
      const options = checkboxes.map((control, index) => ({
        optionIndex: index + 1,
        text: getControlLabel(control),
        imageUrls: extractImageUrls(getControlContainer(control))
      }));
      results.push({
        id: questionId,
        text: finalQuestionText,
        type: "checkbox",
        element: item,
        controls: checkboxes,
        options,
        imageUrls: questionImages
      });
    }
  }

  return results;
}

async function applyAnswers(questionDefs, answers) {
  const answerMap = new Map();
  const orderedAnswers = [];

  for (const answer of answers) {
    const normalized = normalizeModelAnswer(answer);
    orderedAnswers.push(normalized);
    if (answer?.questionId) {
      answerMap.set(answer.questionId, normalized);
    }
  }

  const hasMatchingQuestionId = questionDefs.some((question) => answerMap.has(question.id));
  let appliedCount = 0;
  for (let index = 0; index < questionDefs.length; index += 1) {
    const question = questionDefs[index];
    let value;

    if (answerMap.has(question.id)) {
      value = answerMap.get(question.id);
    } else if (!hasMatchingQuestionId && index < orderedAnswers.length) {
      value = orderedAnswers[index];
    } else {
      continue;
    }

    const success = await applySingleAnswer(question, value);
    if (success) {
      appliedCount += 1;
    }
  }
  return appliedCount;
}

async function applySingleAnswer(question, value) {
  if (question.type === "text" || question.type === "paragraph") {
    const textAnswer = coerceTextAnswer(value);
    if (textAnswer === null || textAnswer === "") {
      return false;
    }
    setTextValue(question.element, textAnswer);
    return true;
  }

  if (question.type === "multiple_choice") {
    const control = resolveSingleChoiceControl(question, value);
    if (!control) {
      return false;
    }
    if (!isChecked(control)) {
      const selected = await clickControl(control);
      if (!selected && !isChecked(control)) {
        return false;
      }
    }
    return true;
  }

  if (question.type === "linear_scale") {
    const control = resolveLinearScaleControl(question, value);
    if (!control) {
      return false;
    }
    if (!isChecked(control)) {
      const selected = await clickControl(control);
      if (!selected && !isChecked(control)) {
        return false;
      }
    }
    return true;
  }

  if (question.type === "checkbox") {
    const targets = normalizeCheckboxTargets(value);
    if (!targets.length) {
      return false;
    }

    const controlsToSelect = resolveCheckboxControls(question, targets);
    if (!controlsToSelect.length) {
      return false;
    }

    if (shouldSkipSelectAllCheckbox(question, controlsToSelect.length)) {
      return false;
    }

    let changed = false;
    for (const control of controlsToSelect) {
      if (!isChecked(control)) {
        const selected = await clickControl(control);
        changed = selected || isChecked(control) || changed;
      }
    }
    return changed;
  }

  if (question.type === "dropdown") {
    return applyDropdownAnswer(question, value);
  }

  return false;
}

function normalizeModelAnswer(answerItem) {
  if (answerItem?.answer !== undefined) {
    return answerItem.answer;
  }
  if (answerItem?.optionIndex !== undefined) {
    return answerItem.optionIndex;
  }
  if (answerItem?.optionIndexes !== undefined) {
    return answerItem.optionIndexes;
  }
  if (answerItem?.text !== undefined) {
    return answerItem.text;
  }
  if (answerItem?.value !== undefined) {
    return answerItem.value;
  }
  if (answerItem?.response !== undefined) {
    return answerItem.response;
  }
  return answerItem;
}

function setTextValue(element, value) {
  element.focus();
  element.value = value;
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

async function clickControl(control) {
  const targets = getUniqueElements([
    control,
    control.closest('[role="radio"]'),
    control.closest('[role="checkbox"]'),
    control.closest('[role="presentation"]'),
    control.parentElement
  ]);

  for (const target of targets) {
    clickElement(target);
    if (await waitForChecked(control, 220)) {
      return true;
    }
    if (target !== control) {
      clickElement(control);
      if (await waitForChecked(control, 220)) {
        return true;
      }
    }
  }

  sendControlKey(control, " ");
  if (await waitForChecked(control, 220)) {
    return true;
  }

  sendControlKey(control, "Enter");
  if (await waitForChecked(control, 220)) {
    return true;
  }

  return isChecked(control);
}

function clickElement(element) {
  element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
  element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
  element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
}

function isChecked(control) {
  return control.getAttribute("aria-checked") === "true";
}

function resolveSingleChoiceControl(question, value) {
  if (Array.isArray(value) && value.length > 0) {
    return resolveSingleChoiceControl(question, value[0]);
  }
  if (value && typeof value === "object") {
    if (value.answer !== undefined) {
      return resolveSingleChoiceControl(question, value.answer);
    }
    if (value.value !== undefined) {
      return resolveSingleChoiceControl(question, value.value);
    }
    if (value.response !== undefined) {
      return resolveSingleChoiceControl(question, value.response);
    }
    if (value.optionIndex !== undefined) {
      return resolveControlByIndexOrNumericText(question, value.optionIndex);
    }
    if (Array.isArray(value.optionIndexes) && value.optionIndexes.length > 0) {
      return resolveControlByIndexOrNumericText(question, value.optionIndexes[0]);
    }
    if (typeof value.text === "string") {
      return resolveControlByText(question, value.text);
    }
  }
  if (typeof value === "number") {
    const exactTextMatch = resolveControlByExactText(question, String(value));
    if (exactTextMatch) {
      return exactTextMatch;
    }
    return resolveControlByIndex(question, value);
  }
  if (typeof value === "string") {
    const numericCandidate = value.trim();
    const exactTextMatch = resolveControlByExactText(question, numericCandidate);
    if (exactTextMatch) {
      return exactTextMatch;
    }
    if (/^-?\d+$/.test(numericCandidate)) {
      return resolveControlByIndex(question, Number(numericCandidate));
    }
    return resolveControlByText(question, value);
  }
  return null;
}

function resolveLinearScaleControl(question, value) {
  const targetValue = extractNumericValue(value);
  if (targetValue !== null) {
    for (const option of question.options || []) {
      const num = extractNumericValue(option.text);
      if (num !== null && num === targetValue) {
        return resolveControlByIndex(question, option.optionIndex);
      }
    }
    const byIndex = resolveControlByIndex(question, targetValue);
    if (byIndex) {
      return byIndex;
    }
  }
  return resolveSingleChoiceControl(question, value);
}

function normalizeCheckboxTargets(value) {
  const rawTargets = [];
  if (Array.isArray(value)) {
    rawTargets.push(...value);
  } else if (value && typeof value === "object") {
    if (Array.isArray(value.answer)) {
      rawTargets.push(...value.answer);
    } else if (Array.isArray(value.optionIndexes)) {
      rawTargets.push(...value.optionIndexes);
    } else if (Array.isArray(value.options)) {
      rawTargets.push(...value.options);
    } else if (value.answer !== undefined) {
      rawTargets.push(value.answer);
    } else if (value.value !== undefined) {
      rawTargets.push(value.value);
    } else if (value.response !== undefined) {
      rawTargets.push(value.response);
    }
  } else if (value !== undefined) {
    rawTargets.push(value);
  }
  return rawTargets;
}

function resolveControlFromTarget(question, target, usedIndexes) {
  let control = null;

  if (typeof target === "number") {
    control = resolveControlByExactText(question, String(target)) || resolveControlByIndex(question, target);
  } else if (typeof target === "string") {
    const trimmed = target.trim();
    control = resolveControlByExactText(question, trimmed);
    if (/^-?\d+$/.test(trimmed)) {
      control = control || resolveControlByIndex(question, Number(trimmed));
    }
    if (!control) {
      control = resolveControlByText(question, target);
    }
  } else if (target && typeof target === "object") {
    if (target.optionIndex !== undefined) {
      control = resolveControlByIndexOrNumericText(question, target.optionIndex);
    }
    if (!control && typeof target.text === "string") {
      control = resolveControlByText(question, target.text);
    }
  }

  if (!control) {
    return null;
  }

  const idx = question.controls.indexOf(control);
  if (idx === -1 || usedIndexes.has(idx)) {
    return null;
  }
  usedIndexes.add(idx);
  return control;
}

function resolveCheckboxControls(question, targets) {
  const controls = [];
  const usedIndexes = new Set();
  for (const target of targets) {
    const control = resolveControlFromTarget(question, target, usedIndexes);
    if (control) {
      controls.push(control);
    }
  }
  return controls;
}

function shouldSkipSelectAllCheckbox(question, selectedCount) {
  const total = question?.controls?.length || 0;
  if (total < 3 || selectedCount !== total) {
    return false;
  }

  const text = normalize(question?.text);
  if (!text) {
    return false;
  }

  const allowAllPatterns = [
    /\ball that apply\b/,
    /\bselect all\b/,
    /\bvyberte vsechny\b/,
    /\boznacte vsechny\b/,
    /\bzaskrtnete vsechny\b/
  ];
  if (allowAllPatterns.some((pattern) => pattern.test(text))) {
    return false;
  }

  const subsetQuestionPatterns = [
    /\bwhich of these\b/,
    /\bwhich of the following\b/,
    /\bktere z techto\b/,
    /\bktere z nasledujicich\b/,
    /\bvyberte\b.*\bspravn/,
    /\burci\b.*\bktere\b/
  ];
  return subsetQuestionPatterns.some((pattern) => pattern.test(text));
}

function resolveControlByIndex(question, value) {
  const index = coerceOptionIndex(value, question.controls.length);
  if (index === null) {
    return null;
  }
  return question.controls[index - 1] || null;
}

function resolveControlByIndexOrNumericText(question, value) {
  const numericTextMatch = resolveControlByExactText(question, String(value));
  if (numericTextMatch) {
    return numericTextMatch;
  }
  return resolveControlByIndex(question, value);
}

function resolveControlByText(question, text) {
  const target = normalize(text);
  if (!target) {
    return null;
  }
  const labeledControls = question.controls
    .map((el) => ({ el, label: normalize(getControlLabel(el)) }))
    .filter((item) => item.label);

  const direct =
    labeledControls.find((item) => item.label === target)?.el ||
    labeledControls.find((item) => item.label.includes(target))?.el ||
    labeledControls.find((item) => target.includes(item.label))?.el;
  if (direct) {
    return direct;
  }

  for (const option of question.options || []) {
    if (normalize(option.text) === target) {
      return resolveControlByIndex(question, option.optionIndex);
    }
  }

  const looseOptionMatch =
    (question.options || []).find((option) => {
      const optionText = normalize(option.text);
      return optionText && (optionText.includes(target) || target.includes(optionText));
    }) || null;
  if (looseOptionMatch) {
    return resolveControlByIndex(question, looseOptionMatch.optionIndex);
  }

  return null;
}

function resolveControlByExactText(question, text) {
  const target = normalize(text);
  if (!target) {
    return null;
  }

  const direct = question.controls.find((el) => {
    const label = normalize(getControlLabel(el));
    return label && label === target;
  });
  if (direct) {
    return direct;
  }

  for (const option of question.options || []) {
    if (normalize(option.text) === target) {
      return resolveControlByIndex(question, option.optionIndex);
    }
  }
  return null;
}

async function applyDropdownAnswer(question, value) {
  const targets = extractDropdownTargets(value);
  if (!targets.length) {
    return false;
  }

  const optionElements = await openDropdownOptions(question.element);
  if (!optionElements.length) {
    return false;
  }

  const selected = resolveDropdownOption(optionElements, targets[0]);
  if (!selected) {
    closeDropdownMenu();
    return false;
  }

  clickElement(selected);
  await sleep(30);
  return true;
}

function extractDropdownTargets(value) {
  if (Array.isArray(value)) {
    return value;
  }
  if (value && typeof value === "object") {
    if (Array.isArray(value.answer)) {
      return value.answer;
    }
    if (value.answer !== undefined) {
      return [value.answer];
    }
    if (value.value !== undefined) {
      return [value.value];
    }
    if (value.response !== undefined) {
      return [value.response];
    }
    if (value.optionIndex !== undefined) {
      return [value.optionIndex];
    }
    if (Array.isArray(value.optionIndexes) && value.optionIndexes.length > 0) {
      return [value.optionIndexes[0]];
    }
    if (typeof value.text === "string") {
      return [value.text];
    }
    return [];
  }
  if (value === undefined) {
    return [];
  }
  return [value];
}

function resolveDropdownOption(optionElements, target) {
  if (typeof target === "number") {
    return (
      resolveDropdownOptionByExactText(optionElements, String(target)) ||
      optionElements[coerceDropdownIndex(target, optionElements.length)] ||
      null
    );
  }

  if (typeof target === "string") {
    const trimmed = target.trim();
    const byExactText = resolveDropdownOptionByExactText(optionElements, trimmed);
    if (byExactText) {
      return byExactText;
    }
    if (/^-?\d+$/.test(trimmed)) {
      const byIndex = optionElements[coerceDropdownIndex(Number(trimmed), optionElements.length)];
      if (byIndex) {
        return byIndex;
      }
    }
    const normalizedTarget = normalize(trimmed);
    const labeledOptions = optionElements
      .map((el) => ({ el, label: normalize(getDropdownOptionLabel(el)) }))
      .filter((item) => item.label);
    const byText =
      labeledOptions.find((item) => item.label === normalizedTarget)?.el ||
      labeledOptions.find((item) => item.label.includes(normalizedTarget))?.el ||
      labeledOptions.find((item) => normalizedTarget.includes(item.label))?.el;
    return byText || null;
  }

  if (target && typeof target === "object") {
    if (target.optionIndex !== undefined) {
      const byExactText = resolveDropdownOptionByExactText(optionElements, String(target.optionIndex));
      if (byExactText) {
        return byExactText;
      }
      const byIndex = optionElements[coerceDropdownIndex(target.optionIndex, optionElements.length)];
      if (byIndex) {
        return byIndex;
      }
    }
    if (typeof target.text === "string") {
      return resolveDropdownOption(optionElements, target.text);
    }
  }

  return null;
}

function resolveDropdownOptionByExactText(optionElements, text) {
  const normalizedTarget = normalize(text);
  if (!normalizedTarget) {
    return null;
  }
  return (
    optionElements.find((el) => {
      const label = normalize(getDropdownOptionLabel(el));
      return label && label === normalizedTarget;
    }) || null
  );
}

function coerceDropdownIndex(value, total) {
  const number = Number(value);
  if (!Number.isInteger(number) || total < 1) {
    return -1;
  }
  if (number >= 1 && number <= total) {
    return number - 1;
  }
  if (number >= 0 && number < total) {
    return number;
  }
  return -1;
}

function coerceOptionIndex(value, totalControls) {
  const number = Number(value);
  if (!Number.isInteger(number) || totalControls < 1) {
    return null;
  }
  if (number >= 1 && number <= totalControls) {
    return number;
  }
  if (number >= 0 && number < totalControls) {
    return number + 1;
  }
  return null;
}

function findDropdownControl(item) {
  const controls = Array.from(item.querySelectorAll('[role="listbox"]'));
  if (!controls.length) {
    return null;
  }
  return controls.find((control) => isElementVisible(control)) || controls[0];
}

async function collectDropdownOptions(dropdownControl) {
  try {
    const options = await openDropdownOptions(dropdownControl);
    const mapped = options.map((option, index) => ({
      optionIndex: index + 1,
      text: getDropdownOptionLabel(option),
      imageUrls: extractImageUrls(option)
    }));
    closeDropdownMenu();
    await sleep(20);
    return mapped.filter((opt) => opt.text || opt.imageUrls.length > 0);
  } catch (_error) {
    closeDropdownMenu();
    return [];
  }
}

async function openDropdownOptions(dropdownControl) {
  dropdownControl.focus();
  clickElement(dropdownControl);
  await sleep(30);

  const options = await waitFor(() => {
    const visible = getVisibleDropdownOptions();
    return visible.length ? visible : null;
  }, 1400, 40);

  return options || [];
}

function closeDropdownMenu() {
  const target = document.activeElement || document.body;
  target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
  target.dispatchEvent(new KeyboardEvent("keyup", { key: "Escape", code: "Escape", bubbles: true }));
}

function getVisibleDropdownOptions() {
  return Array.from(document.querySelectorAll('[role="option"]')).filter((el) => isElementVisible(el));
}

function getDropdownOptionLabel(optionElement) {
  const text =
    optionElement.querySelector(".vRMGwf")?.textContent ||
    optionElement.querySelector(".MocG8c")?.textContent ||
    optionElement.textContent;
  return String(text || "").trim();
}

function looksLikeLinearScale(options, controls) {
  if (controls.length < 3 || controls.length > 11) {
    return false;
  }
  let numericLike = 0;
  for (const option of options) {
    if (extractNumericValue(option.text) !== null) {
      numericLike += 1;
    }
  }
  return numericLike >= Math.max(3, controls.length - 1);
}

function extractNumericValue(value) {
  if (value === null || value === undefined) {
    return null;
  }
  if (Array.isArray(value)) {
    if (!value.length) {
      return null;
    }
    return extractNumericValue(value[0]);
  }
  if (typeof value === "object") {
    if (value.answer !== undefined) {
      return extractNumericValue(value.answer);
    }
    if (value.value !== undefined) {
      return extractNumericValue(value.value);
    }
    if (value.response !== undefined) {
      return extractNumericValue(value.response);
    }
    if (value.optionIndex !== undefined) {
      return extractNumericValue(value.optionIndex);
    }
    if (typeof value.text === "string") {
      return extractNumericValue(value.text);
    }
    return null;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? Math.round(value) : null;
  }
  if (typeof value !== "string") {
    return null;
  }
  const match = value.trim().match(/^-?\d+$/) || value.trim().match(/-?\d+/);
  if (!match) {
    return null;
  }
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? Math.round(parsed) : null;
}

function getQuestionText(container) {
  const heading =
    container.querySelector('[role="heading"]') ||
    container.querySelector(".M7eMe") ||
    container.querySelector(".HoXoMd");
  if (!heading) {
    return "";
  }
  return heading.textContent?.trim() || "";
}

function getControlLabel(control) {
  const aria = String(control.getAttribute("aria-label") || "").trim();
  if (aria) {
    return aria;
  }

  const labelContainer = getControlContainer(control);
  const candidates = [
    labelContainer?.querySelector(".aDTYNe"),
    labelContainer?.querySelector(".ulDsOb"),
    control.parentElement?.querySelector(".aDTYNe"),
    control.parentElement?.querySelector(".ulDsOb")
  ].filter(Boolean);

  for (const candidate of candidates) {
    const text = String(candidate.textContent || "").trim();
    if (text) {
      return text;
    }
  }

  return String(labelContainer?.textContent || "").trim();
}

function getControlContainer(control) {
  return control.closest('[role="presentation"]') || control.parentElement || control;
}

function extractImageUrls(container) {
  if (!container) {
    return [];
  }
  const urls = new Set();
  const images = container.querySelectorAll("img");
  for (const image of images) {
    const src = String(image.currentSrc || image.src || "").trim();
    if (!isUsableImageUrl(src) || !isLikelyQuestionImage(image)) {
      continue;
    }
    urls.add(src);
  }

  const backgroundCandidates = [container, ...container.querySelectorAll('[style*="background"]')];
  for (const element of backgroundCandidates) {
    const inlineStyle = String(element.getAttribute("style") || "");
    if (!inlineStyle || !isLikelyQuestionImageElement(element)) {
      continue;
    }
    const backgroundUrls = extractUrlsFromCssValue(inlineStyle);
    for (const url of backgroundUrls) {
      if (isUsableImageUrl(url)) {
        urls.add(url);
      }
    }
  }

  return Array.from(urls).slice(0, 10);
}

function isUsableImageUrl(url) {
  return /^https?:\/\//i.test(url);
}

function isLikelyQuestionImage(image) {
  const width = Number(image.naturalWidth || image.width || 0);
  const height = Number(image.naturalHeight || image.height || 0);
  if (width > 0 && height > 0 && width < 30 && height < 30) {
    return false;
  }
  const src = String(image.currentSrc || image.src || "");
  if (src.includes("gstatic.com/images/icons/material")) {
    return false;
  }
  return true;
}

function isLikelyQuestionImageElement(element) {
  if (!element || !element.isConnected) {
    return false;
  }
  const rect = element.getBoundingClientRect();
  if (rect.width > 0 && rect.height > 0 && rect.width < 30 && rect.height < 30) {
    return false;
  }
  return true;
}

function extractUrlsFromCssValue(value) {
  const urls = [];
  const regex = /url\(\s*(['"]?)([^"')]+)\1\s*\)/gi;
  let match = regex.exec(value);
  while (match) {
    const url = String(match[2] || "").trim();
    if (url) {
      urls.push(url);
    }
    match = regex.exec(value);
  }
  return urls;
}

function isElementVisible(element) {
  if (!element || !element.isConnected) {
    return false;
  }
  const style = window.getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden") {
    return false;
  }
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function isSelectableControl(control) {
  if (!isElementVisible(control)) {
    return false;
  }
  return control.getAttribute("aria-disabled") !== "true";
}

function getUniqueElements(elements) {
  const unique = [];
  for (const element of elements) {
    if (!element || unique.includes(element)) {
      continue;
    }
    unique.push(element);
  }
  return unique;
}

function sendControlKey(control, key) {
  control.focus();
  const code = key === " " ? "Space" : key;
  control.dispatchEvent(new KeyboardEvent("keydown", { key, code, bubbles: true }));
  control.dispatchEvent(new KeyboardEvent("keyup", { key, code, bubbles: true }));
}

async function waitForChecked(control, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (isChecked(control)) {
      return true;
    }
    await sleep(20);
  }
  return isChecked(control);
}

function createQuestionId(text, index) {
  const slug = String(text || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 50);
  return `${slug || "question"}-${index + 1}`;
}

function composeQuestionText(questionText, contextText, fallbackIndex) {
  const baseText = String(questionText || "").trim();
  const extraContext = String(contextText || "").trim();
  if (!baseText && !extraContext) {
    return `Image question ${fallbackIndex}`;
  }
  if (!baseText) {
    return extraContext;
  }
  if (!extraContext || normalize(baseText) === normalize(extraContext)) {
    return baseText;
  }
  return `${baseText}\nContext: ${extraContext}`;
}

function mergeImageUrls(...lists) {
  const urls = new Set();
  for (const list of lists) {
    if (!Array.isArray(list)) {
      continue;
    }
    for (const url of list) {
      const cleanUrl = String(url || "").trim();
      if (isUsableImageUrl(cleanUrl)) {
        urls.add(cleanUrl);
      }
    }
  }
  return Array.from(urls).slice(0, 10);
}

function normalize(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function coerceTextAnswer(value) {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "string") {
    return value.trim();
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (Array.isArray(value)) {
    const parts = value
      .map((item) => coerceTextAnswer(item))
      .filter((item) => item !== null && item !== "");
    return parts.length ? parts.join(", ") : null;
  }
  if (typeof value === "object") {
    const candidates = [value.answer, value.text, value.value, value.response, value.output];
    for (const candidate of candidates) {
      const parsed = coerceTextAnswer(candidate);
      if (parsed !== null && parsed !== "") {
        return parsed;
      }
    }
    return null;
  }
  return null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(checker, timeoutMs, intervalMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = checker();
    if (result) {
      return result;
    }
    await sleep(intervalMs);
  }
  return null;
}
