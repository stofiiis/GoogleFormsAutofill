# Google Forms AutoFill via OpenAI (Opera Extension)

This extension reads questions from a Google Form, sends them to OpenAI API, then fills detected fields automatically.

## What is supported

- Short text answers
- Paragraph answers
- Multiple choice (single choice)
- Checkboxes (multiple choice)
- Dropdown
- Linear scale
- Image understanding (question/option images are sent to OpenAI Vision)

## Limits

- Google Forms DOM changes can break selectors.
- Date/time and grid types are not implemented in this MVP.
- `File upload` questions cannot be auto-uploaded by this extension.
- Image analysis depends on image URLs being accessible to OpenAI (private/protected URLs may fail).
- CAPTCHA/anti-bot protections cannot be bypassed.
- API key is stored in extension storage on your browser profile, not server-side.

## Install in Opera

1. Open `opera://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this folder (`addon_v2`).

## Setup

1. Open extension details and click **Options** (or use the popup Settings link).
2. Paste your OpenAI API key.
3. Optionally change model (default: `gpt-4.1-mini`, should support vision for photo questions).
4. Save.

## Use

1. Open a Google Form in Opera.
2. Click the extension icon.
3. Add optional instruction (e.g. preferred tone/profile).
4. Click **Analyze and Fill**.
5. Or trigger autofill directly with **Ctrl+Shift+Y** (macOS: **Command+Shift+Y**).

You can customize the shortcut in `opera://extensions/shortcuts`.

## Files

- `manifest.json`: Extension definition (MV3)
- `background.js`: Calls OpenAI API
- `content.js`: Reads form questions and fills answers
- `popup.html` + `popup.js`: Quick action UI
- `options.html` + `options.js`: API settings
- `styles.css`: Shared popup/options styling
