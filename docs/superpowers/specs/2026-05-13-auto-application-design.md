# Auto-Application Feature — Design Document

## 1. Overview

**Feature:** Extend JobOps to handle automatic job applications via a Chrome Extension that executes in the user's authenticated browser, paired with server-side AI payload generation.

**Architecture Pattern:** "Scout & Sniper" hybrid — Cloud Scout (Oracle ARM) handles discovery and intelligence; Local Sniper (MV3 Chrome Extension) handles execution with human oversight.

**Design Constraints:**
- No server-side ATS interaction (avoids CAPTCHA/bot detection entirely)
- Human must approve before submission (prevents catastrophic errors)
- All changes tenant-scoped (existing multi-tenancy pattern)
- Extension communicates with orchestrator via REST API
- V1 scope: Greenhouse + Lever only

---

## 2. System Architecture

```
┌─ THE SCOUT (Oracle Cloud) ─────────────────────────────────┐
│                                                             │
│  JobOps Orchestrator (Express + SQLite/Drizzle + AI)       │
│                                                             │
│  New Endpoints:                                             │
│    GET  /api/applications/prep?url=&ats=                    │
│    POST /api/applications/payload                           │
│    POST /api/applications/confirm                           │
│    GET  /api/applications/pending                           │
│                                                             │
│  Existing systems used:                                     │
│    - Ghostwriter (LLM) for screening answer generation      │
│    - PDF service for tailored resume retrieval              │
│    - Settings registry for autoApplication config           │
│    - tenancy context for multi-tenant isolation             │
│                                                             │
└─────────────────────────────────────────────────────────────┘
                           ↕ REST API (localhost:3005)
┌─ THE SNIPER (Local Chrome) ────────────────────────────────┐
│                                                             │
│  packages/extension/ (MV3 Manifest V3)                     │
│                                                             │
│  background.js   → URL monitoring + ATS detection          │
│  content-script  → Injected into ATS tab                   │
│    ├─ ActionPanel (floating UI overlay)                    │
│    ├─ ApprovalDialog (review mode)                         │
│    └─ ATS Drivers                                          │
│       ├─ ats-detector.js  (URL + DOM fingerprinting)       │
│       ├─ greenhouse.js    (data-qa selectors)              │
│       ├─ lever.js         (name-attr selectors)            │
│       └─ shared/                                          │
│          ├─ native-events.js  (React synthetic dispatch)   │
│          └─ file-injector.js (DataTransfer PDF upload)     │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

## 3. Data Model

### New Table: `applications`

```typescript
// shared/src/types/applications.ts
export interface Application {
  id: string;                    // UUID
  tenantId: string;              // multi-tenant FK
  jobId: string;                 // FK → jobs.id
  atsType: "greenhouse" | "lever";
  status: ApplicationStatus;
  fieldPayload: string | null;   // JSON: filled field snapshot
  screeningAnswers: string | null; // JSON: question→answer map
  customQuestions: string | null;  // JSON: questions from page
  confirmationId: string | null;
  submittedAt: string | null;    // ISO datetime
  screenshotPath: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ApplicationStatus =
  | "preparing"
  | "ready_for_review"
  | "approved"
  | "submitted"
  | "failed"
  | "skipped";
```

### Jobs Table: New Columns

```typescript
auto_applicable?: boolean;
last_application_id?: string;
```

### New Settings

```typescript
"autoApplication.enabled"             // boolean, default false
"autoApplication.defaultCoverLetter"  // string, template text
"autoApplication.salaryRequirement"   // string, e.g. "$120,000-$140,000"
```

---

## 4. API Contracts

All endpoints follow the existing `{ ok, data/error, meta: { requestId } }` response contract.

### `GET /api/applications/prep`

Detects if a job URL is already tracked and returns the candidate profile.

```
Query:  url=<encoded_job_url>&ats=<greenhouse|lever>
Return: { exists, job?, profile, hasTailoredPdf, pdfFreshness, applicationId }
Errors: 400 if missing url, 404 if profile not configured
```

### `POST /api/applications/payload`

Generates the complete fill payload including AI-answered screening questions.

```
Body:   { jobId, atsType, customQuestions: string[] }
Return: { applicationId, fields, cover_letter, screening_answers, resume_pdf_base64, resume_filename }
Errors: 400 if missing fields, 404 if job not found, 422 if PDF can't be generated
```

### `POST /api/applications/confirm`

Records a successful submission.

```
Body:   { jobId, applicationId, atsType, confirmationId, submittedAt, fieldSnapshot, answersSnapshot, screenshotBase64 }
Return: { updated, newStatus }
Errors: 400 if missing fields, 404 if application not found
```

### `GET /api/applications/pending`

Lists all applications awaiting human approval.

```
Query:  (none)
Return: { applications: Application[] }
```

---

## 5. Extension Architecture

### Lifecycle

```
User navigates to boards.greenhouse.io/company/jobs/12345
        │
        ▼
background.js detects URL match
        │
        ▼
Injects content-script.js + greenhouse.js + ActionPanel.jsx
        │
        ▼
Content script calls GET /api/applications/prep?url=...
        │
        ▼
Action Panel renders: "Check JobOps" button
User clicks "Fill Application"
        │
        ▼
Content script scans DOM:
  - Maps standard fields (name, email, phone, etc.)
  - Extracts custom question texts from the page
        │
        ▼
Calls POST /api/applications/payload with extracted questions
        │
        ▼
Receives filled payload + AI answers + PDF blob
        │
        ▼
Executes form fill:
  1. native-events.js fills text/textarea fields
  2. file-injector.js uploads resume PDF
  3. Highlights all filled fields with blue border
        │
        ▼
Action Panel switches to "Review Mode"
User reviews, makes manual edits if needed
        │
        ▼
User clicks ATS native "Submit" button (NOT auto-clicked)
        │
        ▼
Content script monitors for /confirmation page
        │
        ▼
On confirmation: calls POST /api/applications/confirm
                → updates job status to "applied"
```

### Native Event Dispatcher (Critical)

```javascript
function setReactInputValue(element, value) {
  const proto = element.tagName === 'TEXTAREA'
    ? window.HTMLTextAreaElement.prototype
    : window.HTMLInputElement.prototype;
  const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value').set;
  nativeSetter.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
}
```

### File Injection Method

```javascript
function setFileInput(uploadInput, pdfBytes, filename) {
  const file = new File([pdfBytes], filename, { type: 'application/pdf' });
  const dt = new DataTransfer();
  dt.items.add(file);
  uploadInput.files = dt.files;
  uploadInput.dispatchEvent(new Event('change', { bubbles: true }));
}
```

---

## 6. ATS Driver Specifications

### Greenhouse Driver

| Field | Selector |
|-------|----------|
| First Name | `[data-qa="first-name-field"] input` |
| Last Name | `[data-qa="last-name-field"] input` |
| Email | `[data-qa="email-field"] input` |
| Phone | `[data-qa="phone-field"] input` |
| Current Company | `[data-qa="org-field"] input` |
| LinkedIn | `[data-qa="linkedin-field"] input` |
| Cover Letter | `[data-qa="cover-letter-text-input"]` |
| Resume Upload | `[data-qa="resume-upload-input"]` |
| Submit Button | `[data-qa="submit-app-button"]` |
| Custom Questions | `[data-qa^="question_"]` |

**Confirmation:** URL changes to include `/confirmation` or DOM element with `[data-qa="application-confirmation"]`

### Lever Driver

| Field | Selector |
|-------|----------|
| Full Name | `input[name="name"]` |
| Email | `input[name="email"]` |
| Phone | `input[name="phone"]` |
| Current Company | `input[name="org"]` |
| LinkedIn | `input[name="urls[LinkedIn]"]` |
| Portfolio | `input[name="urls[Portfolio]"]` |
| Comments (Cover Letter) | `textarea[name="comments"]` |
| Custom Questions | `li.application-question.custom-question` → `textarea` or `input[type="text"]` |

---

## 7. V1 Scope & Deferrals

### In Scope (V1)
- Chrome MV3 extension
- Greenhouse driver (all field types: text, textarea, file, dropdown, custom Qs)
- Lever driver (all field types)
- 4 new API endpoints in orchestrator
- New `applications` database table + migration
- Ghostwriter integration for screening answer generation
- Action Panel UI (React overlay in Shadow DOM)
- Application confirmation detection + screenshot capture
- Job status update to "applied" on success
- Pending applications list + popup

### Deferred to V2
- LinkedIn Easy Apply support
- Indeed Apply support
- Workday driver (shadow DOM, multi-page navigation)
- Firefox WebExtension support
- Server-side fallback via Camoufox (for custom/unknown ATS)
- Mobile notifications for pending approvals
- Application analytics dashboard
- Multi-profile support
- Agentic fallback (Browser-use / Stagehand for unknown ATS)

### Explicitly Out of Scope
- Fully autonomous submission without human review
- Server-side ATS interaction (would require residential proxies + CAPTCHA solving)
- Background application scheduling

---

## 8. Error Handling

| Scenario | Behavior |
|----------|----------|
| JobOps server unreachable | Extension shows "Server offline — check localhost:3005" |
| No tailored PDF exists | Server auto-generates one before returning payload |
| Custom question unanswerable | Flag as "needs manual input" with red highlight |
| Required field missing from profile | Flag in review mode; don't block |
| ATS page not fully loaded | Wait for `document.readyState === 'complete'` + 2s DOM stability delay |
| Confirmation page not detected | Extension asks user to self-confirm |
| Network failure during confirm | Retry up to 3 times with exponential backoff; store in local Chrome storage |
| Partial DOM change (new CSS classes) | Extension falls back to label-text heuristic matching |

---

## 9. Testing Strategy

| Type | What | How |
|------|------|-----|
| Unit | `native-events.js`, `file-injector.js`, `ats-detector.js` | Vitest with simulated DOM |
| Unit | Application service logic | Existing Jest test setup in orchestrator |
| Integration | Full prep → payload → confirm flow | Test against actual orchestrator with test DB |
| E2E | Extension on real Greenhouse/Lever pages | Load unpacked extension, navigate to test job URLs |
| VCR | AI answer generation | Record/replay Ghostwriter responses to avoid LLM costs in CI |
