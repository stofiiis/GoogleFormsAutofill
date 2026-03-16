const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function createChromeStub() {
  return {
    action: {
      setBadgeBackgroundColor: async () => {},
      setBadgeText: async () => {},
      setTitle: async () => {}
    },
    commands: {
      onCommand: {
        addListener: () => {}
      }
    },
    runtime: {
      onMessage: {
        addListener: () => {}
      }
    },
    scripting: {
      executeScript: async () => {}
    },
    storage: {
      local: {
        get: async () => ({}),
        set: async () => {}
      },
      sync: {
        get: async () => ({}),
        set: async () => {}
      }
    },
    tabs: {
      query: async () => [],
      sendMessage: async () => ({ ok: true })
    }
  };
}

function loadBackgroundContext() {
  const source = fs.readFileSync(path.join(__dirname, "background.js"), "utf8");
  const sandbox = {
    AbortController,
    chrome: createChromeStub(),
    clearTimeout,
    console,
    fetch: async () => {
      throw new Error("fetch should not be called in smoke tests");
    },
    setTimeout
  };

  vm.runInNewContext(source, sandbox, { filename: "background.js" });
  return sandbox;
}

function testSingleChoiceLooseMatch(background) {
  const result = background.normalizeAnswerForQuestion("The correct answer is Paris", {
    type: "multiple_choice",
    options: [
      { optionIndex: 1, text: "Paris" },
      { optionIndex: 2, text: "London" },
      { optionIndex: 3, text: "Rome" }
    ]
  });

  assert.equal(result.ok, true);
  assert.equal(result.value, 1);
}

function testNumericOptionLabels(background) {
  const result = background.normalizeAnswerForQuestion(2, {
    type: "multiple_choice",
    options: [
      { optionIndex: 1, text: "2" },
      { optionIndex: 2, text: "8" }
    ]
  });

  assert.equal(result.ok, true);
  assert.equal(result.value, "2");
}

function testCheckboxPartialRecovery(background) {
  const result = background.normalizeAnswerForQuestion([1, "not-an-option"], {
    type: "checkbox",
    options: [
      { optionIndex: 1, text: "HTML" },
      { optionIndex: 2, text: "CSS" },
      { optionIndex: 3, text: "JavaScript" }
    ]
  });

  assert.equal(result.ok, false);
  assert.deepEqual(Array.from(result.value), [1]);
  assert.match(result.reason, /unmatched target/);
}

function testLinearScaleNormalization(background) {
  const result = background.normalizeAnswerForQuestion("rating 5", {
    type: "linear_scale",
    options: [
      { optionIndex: 1, text: "1" },
      { optionIndex: 2, text: "2" },
      { optionIndex: 3, text: "3" },
      { optionIndex: 4, text: "4" },
      { optionIndex: 5, text: "5" }
    ]
  });

  assert.equal(result.ok, true);
  assert.equal(result.value, 5);
}

function main() {
  const background = loadBackgroundContext();
  testSingleChoiceLooseMatch(background);
  testNumericOptionLabels(background);
  testCheckboxPartialRecovery(background);
  testLinearScaleNormalization(background);
  console.log("Smoke tests passed.");
}

main();
