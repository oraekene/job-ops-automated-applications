---
id: auto-application
title: Auto-Application (JobOps Copilot)
description: Automatically apply to jobs on Greenhouse and Lever using AI-generated answers and your profile
sidebar_position: 8
---

# Auto-Application (JobOps Copilot)

## What it is

JobOps Copilot is a Chrome extension that automatically fills and submits job applications on Greenhouse and Lever job boards. It uses your JobOps profile data — tailored resume, cover letter, and AI-generated screening answers — to complete applications end-to-end without human review steps.

The extension runs inside your authenticated browser session, so there are no CAPTCHAs, no bot detection, and no IP blocks.

**This is a fully autonomous flow** — once enabled, the extension polls the orchestrator for a queue of auto-applicable jobs, opens each one in a background tab, fills the form with your real profile data and AI-generated answers, submits it, and reports the result back. You do not click "Fill Application" or "Submit" yourself.

## Why it exists

JobOps already handles job discovery, AI-powered resume tailoring, cover letter generation, and screening-answer generation — but the final step (actually submitting the application) was manual. The Copilot extension closes that gap by automating the entire form-filling and submission step while keeping you informed via a live queue status indicator.

## How to use it

### Prerequisites

- JobOps orchestrator server running on `http://localhost:3005`
- Chrome browser (Manifest V3)
- Onboarding complete in JobOps (profile, base resume, LLM API key configured)
- At least one job in the database with `auto_applicable = true` (set via the orchestrator UI or by importing jobs that match your search criteria)

### Installation

1. Build the extension:
   ```bash
   cd job-ops-main
   npm --workspace packages/extension run build
   ```
2. Open Chrome and go to `chrome://extensions`
3. Enable "Developer mode" (toggle in top-right)
4. Click "Load unpacked" and select `job-ops-main/packages/extension/dist`
5. The JobOps Copilot icon appears in your toolbar

### Enable Auto-Apply

1. Click the JobOps Copilot icon in your toolbar to open the popup
2. Toggle **Auto-apply** to ON
3. The status line updates to show `Queue: N pending · M applied today`
4. The background service worker starts polling the orchestrator every 30 seconds

### What happens next

- Every 30 seconds, the extension requests up to 10 auto-applicable jobs from `GET /api/applications/queue`
- For each job, it opens a background tab with `?jobId=<id>` appended to the Greenhouse/Lever URL
- The content script detects the ATS, calls `POST /api/applications/payload` to get your profile, screening answers, cover letter, and tailored PDF
- It fills all form fields, uploads the PDF via DataTransfer, and submits the application
- On success: reports `outcome: "submitted"` to `POST /api/applications/queue-result`, captures a screenshot, closes the tab
- On blocker (CAPTCHA, MFA, sign-in modal, unknown ATS): reports `outcome: "skipped"` with reason, closes the tab, continues to next job
- On timeout (120s): reports `outcome: "failed", reason: "timeout"`, closes the tab
- The queue status in the popup updates every 10 seconds while open

### Settings

Click the JobOps icon in your toolbar to open the popup:
- **Auto-apply** (toggle): Enable/disable autonomous application processing. Stored in `chrome.storage.local`.
- **Queue status**: Live indicator showing `pending`, `applied today`, `skipped today`, `failed today`, and `Last run` timestamp.

## Supported ATS Platforms

| Platform | Status | Notes |
|----------|--------|-------|
| Greenhouse | ✅ Supported | Uses `data-qa` selectors; detects CAPTCHA, "Sign in to apply" modal |
| Lever | ✅ Supported | Uses `name` attribute selectors; detects "Sign in" modal |
| LinkedIn Easy Apply | 🔜 Planned | Not supported in this release |
| Workday | 🔜 Planned | Not supported in this release |
| Indeed Apply | 🔜 Planned | Not supported in this release |

## Queue Semantics

- **Eligibility**: Jobs must have `auto_applicable = true` in the database AND the orchestrator setting `autoApplicationEnabled` must be ON.
- **Ordering**: Queue returns jobs ordered by `suitabilityScore DESC`, then `createdAt ASC`.
- **Concurrency**: Maximum 3 tabs open at once (configurable via `MAX_CONCURRENT_TABS` in background.ts).
- **Idempotency**: If the extension reports twice for the same `jobId`, the orchestrator updates the existing application row rather than creating a duplicate.
- **Stale cleanup**: Application rows stuck in `ready_for_review` for >1 hour are automatically marked `skipped` with `errorMessage: "stale payload"` on orchestrator startup and hourly thereafter.

## Common problems

**"JobOps: Can't reach server at http://localhost:3005"**
Ensure your orchestrator server is running. Start it with `docker compose up` or `npm run start` from `job-ops-main/orchestrator`.

**"Auto-apply toggle is on but queue shows 0 pending"**
- Check that `autoApplicationEnabled` is ON in the orchestrator settings (Settings → Auto-Application).
- Verify jobs exist with `auto_applicable = true` (run a pipeline or import jobs).
- Ensure onboarding is complete (profile, base resume, LLM key).

**"Job is being skipped — why?"**
The three most common skip reasons and how to check:
1. **CAPTCHA detected** — Greenhouse/Lever presented a reCAPTCHA or hCaptcha. Open the application in the orchestrator UI → check the `applications` table for `status = 'skipped'` and `errorMessage = 'reCAPTCHA detected'` (or `hCaptcha detected`).
2. **Sign-in required** — The ATS showed a "Sign in to apply" modal. Check `errorMessage = 'sign-in required'`.
3. **Unknown ATS** — The URL host didn't match `greenhouse.io` or `lever.co`. Check `errorMessage = 'unknown ATS'`.

**"Application timed out"**
If a tab takes longer than 120 seconds to load/fill/submit, it reports `outcome: "failed", reason: "timeout"`. Increase `TAB_TIMEOUT_MS` in `background.ts` if your network is slow.

**"PDF upload failed"**
The content script looks for a file input on the page. If none is found, the job is skipped with `reason: 'no resume upload input'`. Some ATS customizations remove the file input — manual intervention needed.

## Related pages

- [Pipeline Run](/docs/next/features/pipeline-run)
- [Ghostwriter](/docs/next/features/ghostwriter)
- [Resume Tailoring](/docs/next/features/reactive-resume)
- [Settings](/docs/next/features/settings)
