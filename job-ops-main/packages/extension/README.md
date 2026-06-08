# JobOps Copilot Extension

Chrome extension for the JobOps autonomous job application system. Runs as a Manifest V3 service worker with a React popup UI.

## How it works

1. Background service worker polls the orchestrator every 30s for auto-applicable jobs
2. Opens each Greenhouse/Lever job in a background tab with a `?jobId=` parameter
3. Content script detects the ATS, calls the orchestrator for profile data + AI answers + tailored PDF
4. Fills the form, uploads the PDF, submits, and reports the outcome
5. Blockers (CAPTCHA, MFA, sign-in modals, unknown ATS) are detected and skipped

## Installation

```bash
npm run build
```

Open `chrome://extensions`, enable Developer mode, click "Load unpacked", select `dist/`.

## Host Permission

The extension connects to the orchestrator at `http://localhost:3005`. Update the `host_permissions` in `manifest.json` if your orchestrator runs elsewhere.

## Architecture

- `background.ts` — Service worker: alarm-based poll loop, tab dispatch, result forwarding, 120s timeout
- `src/content-script.ts` — Injected into ATS pages: form fill, PDF upload, submit detection, blocker detection
- `src/popup/` — React popup: auto-apply toggle + queue status indicator
- `src/lib/` — API client (`jobops-api.ts`), blocker detection (`detect-blocker.ts`)
- `src/drivers/` — ATS-specific form fillers (greenhouse, lever) and shared utilities

## Development

```bash
npm run dev    # watch mode with HMR
npm run build  # production build to dist/
npm test       # vitest suite (68+ tests)
```
