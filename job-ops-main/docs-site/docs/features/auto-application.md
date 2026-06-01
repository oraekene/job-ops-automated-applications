---
id: auto-application
title: Auto-Application (JobOps Copilot)
description: Automatically fill job applications on Greenhouse and Lever using AI-generated answers
sidebar_position: 8
---

# Auto-Application (JobOps Copilot)

## What it is

JobOps Copilot is a Chrome extension that automatically fills job application forms on Greenhouse and Lever job boards. It uses your JobOps profile data — tailored resume, cover letter, and AI-generated screening answers — to complete applications in your browser with a single click.

The extension runs inside your authenticated browser session, so there are no CAPTCHAs, no bot detection, and no IP blocks.

## Why it exists

JobOps already handles job discovery, AI-powered resume tailoring, and cover letter generation — but the final step (actually submitting the application) has always been manual. The Copilot extension closes that gap by automating the form-filling step while keeping you in control of the final submit click.

## How to use it

### Prerequisites

- JobOps server running on `localhost:3005`
- Chrome browser
- Tailored resume generated for at least one job (via the JobOps pipeline)

### Installation

1. Build the extension: `npm --workspace job-ops-extension run build`
2. Open Chrome and go to `chrome://extensions`
3. Enable "Developer mode" (toggle in top-right)
4. Click "Load unpacked" and select `packages/extension/dist`
5. The JobOps Copilot icon appears in your toolbar

### Usage

1. Navigate to a Greenhouse or Lever job posting
2. The JobOps panel appears in the bottom-right corner
3. Click "Fill Application"
4. Review the filled fields (blue highlighted)
5. Answer any missing required fields manually
6. Click the ATS "Submit" button yourself
7. JobOps detects the confirmation and marks the job as "Applied"

### Settings

Click the JobOps icon in your toolbar to open settings:
- **Server URL**: Your JobOps server address (default: `http://localhost:3005`)
- **Auto-fill on page load**: Automatically trigger fill when you land on a supported job page

## Supported ATS Platforms

| Platform | Status | Selectors |
|----------|--------|-----------|
| Greenhouse | ✅ Supported | `data-qa` attributes |
| Lever | ✅ Supported | `name` attributes |
| LinkedIn Easy Apply | 🔜 Planned | Modal overlay |
| Workday | 🔜 Planned | Shadow DOM |
| Indeed Apply | 🔜 Planned | Direct API |

## Common problems

**"JobOps: Can't reach server at localhost:3005"**
Ensure your JobOps server is running. Start it with `docker compose up` or `npm run start`.

**"No application form detected"**
The page may not be a standard Greenhouse or Lever application page. Try refreshing or navigating to the direct "Apply" link.

**Fields are not being filled**
Some ATS customizations use non-standard field names. The missing fields will be highlighted — please fill them manually.

**Confirmation not detected**
If the confirmation page doesn't match expected patterns, the extension will ask you to manually confirm the submission went through.

## Related pages

- [Pipeline Run](/docs/next/features/pipeline-run)
- [Ghostwriter](/docs/next/features/ghostwriter)
- [Resume Tailoring](/docs/next/features/reactive-resume)
