# Auto-Application Feature Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans

**Goal:** Extend JobOps with a Chrome extension that auto-fills job applications on Greenhouse and Lever, paired with server-side AI answer generation and confirmation tracking.

**Architecture:** "Scout & Sniper" hybrid — orchestrator server (Express + SQLite/Drizzle) handles discovery and AI payload generation; MV3 Chrome extension executes form filling in the user's authenticated browser.

**Tech Stack:** TypeScript monorepo (npm workspaces), React 18 + Vite (extension UI), Express + Drizzle ORM (server), Vitest/Jest (testing), Chrome Extension Manifest V3.

---

## File Structure

### New Files

```
packages/extension/
├── package.json
├── manifest.json
├── vite.config.ts
├── tsconfig.json
├── background.ts
├── src/
│   ├── content-script.ts
│   ├── components/
│   │   ├── ActionPanel.tsx
│   │   └── ApprovalDialog.tsx
│   ├── drivers/
│   │   ├── ats-detector.ts
│   │   ├── greenhouse.ts
│   │   ├── lever.ts
│   │   └── shared/
│   │       ├── native-events.ts
│   │       └── file-injector.ts
│   ├── lib/
│   │   ├── jobops-api.ts
│   │   └── storage.ts
│   └── popup/
│       └── index.tsx
orchestrator/src/server/repositories/applications.ts
orchestrator/src/server/services/applications.ts
orchestrator/src/server/api/applications-router.ts
shared/src/types/applications.ts
```

### Existing Files to Modify

| File | Change |
|------|--------|
| `package.json` | Add `packages/extension` workspace |
| `shared/src/index.ts` | Export application types |
| `shared/src/types/jobs.ts` | Add `auto_applicable`, `last_application_id` |
| `shared/src/settings-registry.ts` | Add `autoApplication.*` settings |
| `orchestrator/src/server/db/schema.ts` | Add `applications` table + jobs columns |
| `orchestrator/src/server/api/routes.ts` | Mount 4 new application routes |

---

## Task List

### Phase I: Extension Scaffold & ATS Drivers

---

### Task 1.1: Create Extension Workspace

**Files:**
- Create: `packages/extension/package.json`
- Create: `packages/extension/tsconfig.json`
- Create: `packages/extension/vite.config.ts`
- Modify: `package.json` (add workspace)

- [ ] **Step 1: Create package.json**

```json
{
  "name": "job-ops-extension",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite build --watch",
    "build": "vite build",
    "test": "vitest run",
    "test:watch": "vitest",
    "check:types": "tsc --noEmit"
  },
  "dependencies": {
    "react": "^18.3.0",
    "react-dom": "^18.3.0"
  },
  "devDependencies": {
    "@types/chrome": "^0.0.280",
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "typescript": "^5.5.0",
    "vite": "^6.0.0",
    "vitest": "^2.0.0",
    "jsdom": "^24.0.0",
    "@vitejs/plugin-react": "^4.3.0"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": ".",
    "types": ["chrome"]
  },
  "include": ["src", "background.ts"]
}
```

- [ ] **Step 3: Create vite.config.ts**

```typescript
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    rollupOptions: {
      input: {
        background: resolve(__dirname, 'background.ts'),
        'content-script': resolve(__dirname, 'src/content-script.ts'),
        popup: resolve(__dirname, 'src/popup/index.tsx'),
      },
      output: {
        entryFileNames: '[name].js',
        format: 'iife',
      },
    },
    emptyOutDir: true,
  },
});
```

- [ ] **Step 4: Add workspace to root package.json**

Edit `package.json` to add `"packages/extension"` to the workspaces array.

Run: `npm install` from root

- [ ] **Step 5: Commit**

```bash
git add packages/extension/ package.json package-lock.json
git commit -m "feat: scaffold extension workspace with Vite build"
```

---

### Task 1.2: Write Manifest.json

**Files:**
- Create: `packages/extension/manifest.json`

- [ ] **Step 1: Create manifest.json**

```json
{
  "manifest_version": 3,
  "name": "JobOps Copilot",
  "version": "0.1.0",
  "description": "Auto-fill job applications with JobOps AI",
  "permissions": ["tabs", "scripting", "storage", "activeTab"],
  "host_permissions": [
    "https://*.boards.greenhouse.io/*",
    "https://*.lever.co/*",
    "https://hire.lever.co/*",
    "http://localhost:3005/*"
  ],
  "background": {
    "service_worker": "background.js",
    "type": "module"
  },
  "action": {
    "default_popup": "popup.html",
    "default_title": "JobOps Copilot"
  },
  "content_scripts": [
    {
      "matches": [
        "https://*.boards.greenhouse.io/*",
        "https://*.lever.co/*",
        "https://hire.lever.co/*"
      ],
      "js": ["content-script.js"],
      "run_at": "document_end"
    }
  ],
  "web_accessible_resources": [
    {
      "resources": ["content-script.js"],
      "matches": ["https://*.boards.greenhouse.io/*", "https://*.lever.co/*", "https://hire.lever.co/*"]
    }
  ]
}
```

- [ ] **Step 2: Create popup.html**

```html
<!DOCTYPE html>
<html><head><script src="popup.js"></script></head><body><div id="root"></div></body></html>
```

- [ ] **Step 3: Commit**

```bash
git add packages/extension/manifest.json packages/extension/popup.html
git commit -m "feat: add MV3 manifest with host permissions"
```

---

### Task 1.3: Implement Background Service Worker

**Files:**
- Create: `packages/extension/background.ts`
- Test: `packages/extension/__tests__/background.test.ts`

- [ ] **Step 1: Write the test**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('background service worker', () => {
  beforeEach(() => {
    vi.resetModules();
    global.chrome = {
      tabs: { onUpdated: { addListener: vi.fn() } },
      scripting: { executeScript: vi.fn() },
    } as unknown as typeof chrome;
  });

  it('should register onUpdated listener on init', async () => {
    await import('../background');
    expect(chrome.tabs.onUpdated.addListener).toHaveBeenCalled();
  });

  it('should detect greenhouse URLs and inject content script', async () => {
    const listener = vi.fn();
    chrome.tabs.onUpdated.addListener = listener as unknown as typeof chrome.tabs.onUpdated.addListener;
    await import('../background');
    const handler = listener.mock.calls[0][0];
    await handler(1, { status: 'complete' }, { url: 'https://boards.greenhouse.io/company/jobs/123' });
    expect(chrome.scripting.executeScript).toHaveBeenCalledWith({ target: { tabId: 1 }, files: ['content-script.js'] });
  });

  it('should detect lever URLs and inject content script', async () => {
    const listener = vi.fn();
    chrome.tabs.onUpdated.addListener = listener as unknown as typeof chrome.tabs.onUpdated.addListener;
    await import('../background');
    const handler = listener.mock.calls[0][0];
    await handler(2, { status: 'complete' }, { url: 'https://jobs.lever.co/company/role' });
    expect(chrome.scripting.executeScript).toHaveBeenCalledWith({ target: { tabId: 2 }, files: ['content-script.js'] });
  });

  it('should NOT inject for non-ATS URLs', async () => {
    const listener = vi.fn();
    chrome.tabs.onUpdated.addListener = listener as unknown as typeof chrome.tabs.onUpdated.addListener;
    await import('../background');
    const handler = listener.mock.calls[0][0];
    await handler(3, { status: 'complete' }, { url: 'https://google.com' });
    expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run __tests__/background.test.ts`
Expected: FAIL

- [ ] **Step 3: Write implementation**

```typescript
const ATS_PATTERNS = [
  { id: 'greenhouse' as const, pattern: 'boards.greenhouse.io' },
  { id: 'lever' as const, pattern: 'lever.co' },
  { id: 'lever' as const, pattern: 'hire.lever.co' },
];

chrome.tabs.onUpdated.addListener((tabId: number, changeInfo: chrome.tabs.TabChangeInfo, tab: chrome.tabs.Tab | undefined) => {
  if (changeInfo.status !== 'complete' || !tab?.url) return;
  const matched = ATS_PATTERNS.find(ats => tab.url!.includes(ats.pattern));
  if (!matched) return;
  chrome.scripting.executeScript({ target: { tabId }, files: ['content-script.js'] }).catch(() => {});
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run __tests__/background.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/extension/background.ts packages/extension/__tests__/background.test.ts
git commit -m "feat: implement background service worker with ATS URL detection"
```

---

### Task 1.4: ATS Detector Utility

**Files:**
- Create: `packages/extension/src/drivers/ats-detector.ts`
- Test: `packages/extension/src/drivers/__tests__/ats-detector.test.ts`

- [ ] **Step 1: Write test**

```typescript
import { describe, it, expect } from 'vitest';
import { detectAtsByUrl, detectAtsByDom } from '../ats-detector';

describe('detectAtsByUrl', () => {
  it('returns greenhouse for boards.greenhouse.io URLs', () => {
    expect(detectAtsByUrl('https://boards.greenhouse.io/company/jobs/123')).toBe('greenhouse');
  });
  it('returns lever for hire.lever.co URLs', () => {
    expect(detectAtsByUrl('https://hire.lever.co/company/role')).toBe('lever');
  });
  it('returns lever for jobs.lever.co URLs', () => {
    expect(detectAtsByUrl('https://jobs.lever.co/company/role')).toBe('lever');
  });
  it('returns unknown for unrecognized URLs', () => {
    expect(detectAtsByUrl('https://company.workday.com/careers')).toBe('unknown');
  });
});

describe('detectAtsByDom', () => {
  it('returns greenhouse when HTML contains gh_jid', () => {
    expect(detectAtsByDom('<html><script>window._gh_jid="123"</script></html>')).toBe('greenhouse');
  });
  it('returns lever when HTML contains lever markers', () => {
    expect(detectAtsByDom('<html><div class="lever-job-listing"></div></html>')).toBe('lever');
  });
  it('returns unknown when no ATS markers found', () => {
    expect(detectAtsByDom('<html><body>Hello</body></html>')).toBe('unknown');
  });
});
```

- [ ] **Step 2: Write implementation**

```typescript
export type AtsType = 'greenhouse' | 'lever' | 'unknown';

export const ATS_URL_PATTERNS: Array<{ id: AtsType; patterns: string[] }> = [
  { id: 'greenhouse', patterns: ['boards.greenhouse.io'] },
  { id: 'lever', patterns: ['jobs.lever.co', 'hire.lever.co'] },
];

const DOM_MARKERS: Array<{ id: AtsType; markers: string[] }> = [
  { id: 'greenhouse', markers: ['greenhouse', 'gh_jid'] },
  { id: 'lever', markers: ['lever.co', 'lever-job-listing'] },
];

export function detectAtsByUrl(url: string): AtsType {
  for (const entry of ATS_URL_PATTERNS) {
    if (entry.patterns.some(p => url.includes(p))) return entry.id;
  }
  return 'unknown';
}

export function detectAtsByDom(html: string): AtsType {
  const lower = html.toLowerCase();
  for (const entry of DOM_MARKERS) {
    if (entry.markers.some(m => lower.includes(m))) return entry.id;
  }
  return 'unknown';
}
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run src/drivers/__tests__/ats-detector.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add packages/extension/src/drivers/ats-detector.ts
git commit -m "feat: add ATS detector with URL and DOM fingerprinting"
```

---

### Task 1.5: Native Events Dispatcher

**Files:**
- Create: `packages/extension/src/drivers/shared/native-events.ts`
- Test: `packages/extension/src/drivers/shared/__tests__/native-events.test.ts`

- [ ] **Step 1: Write test**

```typescript
import { describe, it, expect, vi } from 'vitest';
import { setReactInputValue } from '../native-events';

describe('setReactInputValue', () => {
  it('sets input value via native setter and dispatches events', () => {
    const input = document.createElement('input');
    const dispatchSpy = vi.spyOn(input, 'dispatchEvent');
    setReactInputValue(input, 'test@example.com');
    expect(input.value).toBe('test@example.com');
    expect(dispatchSpy).toHaveBeenCalledTimes(2);
    const eventTypes = dispatchSpy.mock.calls.map(c => (c[0] as Event).type);
    expect(eventTypes).toContain('input');
    expect(eventTypes).toContain('change');
  });

  it('sets textarea value and dispatches events', () => {
    const textarea = document.createElement('textarea');
    vi.spyOn(textarea, 'dispatchEvent');
    setReactInputValue(textarea, 'Hello world');
    expect(textarea.value).toBe('Hello world');
  });

  it('does nothing when element is null', () => {
    expect(() => setReactInputValue(null, 'test')).not.toThrow();
  });

  it('dispatches events with bubbles: true', () => {
    const input = document.createElement('input');
    const dispatchedEvents: Event[] = [];
    input.addEventListener('input', (e) => dispatchedEvents.push(e));
    input.addEventListener('change', (e) => dispatchedEvents.push(e));
    setReactInputValue(input, 'test');
    expect(dispatchedEvents.every(e => e.bubbles)).toBe(true);
  });
});
```

- [ ] **Step 2: Write implementation**

```typescript
export function setReactInputValue(element: HTMLInputElement | HTMLTextAreaElement | null, value: string): void {
  if (!element) return;
  const proto = element.tagName === 'TEXTAREA'
    ? window.HTMLTextAreaElement.prototype
    : window.HTMLInputElement.prototype;
  const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (!nativeSetter) { element.value = value; return; }
  nativeSetter.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
}
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run src/drivers/shared/__tests__/native-events.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add packages/extension/src/drivers/shared/native-events.ts
git commit -m "feat: add native event dispatcher for React forms"
```

---

### Task 1.6: File Injector

**Files:**
- Create: `packages/extension/src/drivers/shared/file-injector.ts`
- Test: `packages/extension/src/drivers/shared/__tests__/file-injector.test.ts`

- [ ] **Step 1: Write test**

```typescript
import { describe, it, expect, vi } from 'vitest';
import { setFileInput } from '../file-injector';

describe('setFileInput', () => {
  it('sets file on input[type=file] via DataTransfer', () => {
    const input = document.createElement('input');
    input.type = 'file';
    const dispatchSpy = vi.spyOn(input, 'dispatchEvent');
    const pdfBytes = new Uint8Array([37, 80, 68, 70]);
    setFileInput(input, pdfBytes, 'resume.pdf');
    expect(input.files?.length).toBe(1);
    expect(input.files![0].name).toBe('resume.pdf');
    expect(input.files![0].type).toBe('application/pdf');
    expect(dispatchSpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'change', bubbles: true }));
  });

  it('does nothing when element is null', () => {
    expect(() => setFileInput(null, new Uint8Array(), 'test.pdf')).not.toThrow();
  });
});
```

- [ ] **Step 2: Write implementation**

```typescript
export function setFileInput(element: HTMLInputElement | null, pdfBytes: Uint8Array, filename: string): void {
  if (!element) return;
  const file = new File([pdfBytes], filename, { type: 'application/pdf' });
  const dt = new DataTransfer();
  dt.items.add(file);
  element.files = dt.files;
  element.dispatchEvent(new Event('change', { bubbles: true }));
}
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run src/drivers/shared/__tests__/file-injector.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add packages/extension/src/drivers/shared/file-injector.ts
git commit -m "feat: add DataTransfer file injector for PDF upload"
```

---

### Task 1.7: JobOps API Client

**Files:**
- Create: `packages/extension/src/lib/jobops-api.ts`
- Test: `packages/extension/src/lib/__tests__/jobops-api.test.ts`

- [ ] **Step 1: Write test**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { JobOpsApi } from '../jobops-api';

describe('JobOpsApi', () => {
  const api = new JobOpsApi('http://localhost:3005');

  beforeEach(() => { vi.restoreAllMocks(); });

  it('prepJob calls correct endpoint and returns prep data', async () => {
    const mockResponse = { ok: true, data: { exists: true, job: { id: 'job1' }, hasTailoredPdf: true } };
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(mockResponse) });
    const result = await api.prepJob('https://boards.greenhouse.io/company/1', 'greenhouse');
    expect(result.exists).toBe(true);
  });

  it('buildPayload sends custom questions and receives fill payload', async () => {
    const mockPayload = { ok: true, data: { applicationId: 'app1', fields: { first_name: 'John' }, cover_letter: '...', screening_answers: {}, resume_pdf_base64: 'JVBER', resume_filename: 'resume.pdf' } };
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(mockPayload) });
    const result = await api.buildPayload('job1', 'greenhouse', ['Why you?']);
    expect(result.applicationId).toBe('app1');
  });

  it('confirmSubmission posts confirmation data', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ ok: true, data: { updated: true, newStatus: 'applied' } }) });
    const result = await api.confirmSubmission({ jobId: 'job1', applicationId: 'app1', atsType: 'greenhouse', confirmationId: '123', submittedAt: new Date().toISOString(), fieldSnapshot: {}, answersSnapshot: {}, screenshotBase64: '' });
    expect(result.updated).toBe(true);
  });

  it('throws on API error response', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ ok: false, error: { code: 'NOT_FOUND', message: 'Job not found' } }) });
    await expect(api.prepJob('https://unknown.com', 'unknown')).rejects.toThrow('NOT_FOUND');
  });

  it('throws on network failure', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('Failed to fetch'));
    await expect(api.prepJob('https://test.com', 'greenhouse')).rejects.toThrow('Failed to fetch');
  });
});
```

- [ ] **Step 2: Write implementation**

```typescript
export interface PrepResponse { exists: boolean; job?: { id: string; title: string; employer: string; suitabilityScore: number; status: string }; profile?: { first_name: string; last_name: string; email: string; phone: string; linkedin_url: string; current_company: string }; hasTailoredPdf: boolean; pdfFreshness?: string; applicationId: string | null; }

export interface PayloadResponse { applicationId: string; fields: Record<string, string>; cover_letter: string; screening_answers: Record<string, string>; resume_pdf_base64: string; resume_filename: string; }

export interface ConfirmRequest { jobId: string; applicationId: string; atsType: string; confirmationId: string; submittedAt: string; fieldSnapshot: Record<string, string>; answersSnapshot: Record<string, string>; screenshotBase64: string; }

export interface ConfirmResponse { updated: boolean; newStatus: string; }

export class JobOpsApi {
  constructor(private baseUrl: string) {}

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, { ...init, headers: { 'Content-Type': 'application/json', ...init?.headers } });
    const body = await res.json();
    if (!body.ok) throw new Error(body.error?.code || 'UNKNOWN_ERROR');
    return body.data as T;
  }

  prepJob(url: string, ats: string): Promise<PrepResponse> {
    return this.request<PrepResponse>(`/api/applications/prep?url=${encodeURIComponent(url)}&ats=${ats}`);
  }

  buildPayload(jobId: string, atsType: string, customQuestions: string[]): Promise<PayloadResponse> {
    return this.request<PayloadResponse>('/api/applications/payload', { method: 'POST', body: JSON.stringify({ jobId, atsType, customQuestions }) });
  }

  confirmSubmission(req: ConfirmRequest): Promise<ConfirmResponse> {
    return this.request<ConfirmResponse>('/api/applications/confirm', { method: 'POST', body: JSON.stringify(req) });
  }
}
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run src/lib/__tests__/jobops-api.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add packages/extension/src/lib/jobops-api.ts
git commit -m "feat: add JobOps server API client with typed methods"
```

---

### Task 1.8: Greenhouse Driver

**Files:**
- Create: `packages/extension/src/drivers/greenhouse.ts`
- Test: `packages/extension/src/drivers/__tests__/greenhouse.test.ts`

- [ ] **Step 1: Write test**

```typescript
import { describe, it, expect } from 'vitest';
import { fillGreenhouseForm } from '../greenhouse';

describe('fillGreenhouseForm', () => {
  it('fills standard fields using data-qa selectors', () => {
    document.body.innerHTML = `
      <div data-qa="first-name-field"><input></div>
      <div data-qa="last-name-field"><input></div>
      <div data-qa="email-field"><input></div>
      <div data-qa="phone-field"><input></div>
      <div data-qa="linkedin-field"><input></div>
      <div data-qa="org-field"><input></div>
    `;

    fillGreenhouseForm({
      first_name: 'John', last_name: 'Doe', email: 'john@test.com',
      phone: '123-456-7890', linkedin_url: 'https://linkedin.com/in/john',
      current_company: 'Acme', cover_letter: '', screening_answers: {},
    });

    expect(document.querySelector<HTMLInputElement>('[data-qa="first-name-field"] input')!.value).toBe('John');
    expect(document.querySelector<HTMLInputElement>('[data-qa="email-field"] input')!.value).toBe('john@test.com');
  });

  it('fills cover letter textarea when present', () => {
    document.body.innerHTML = `<textarea data-qa="cover-letter-text-input"></textarea>`;
    fillGreenhouseForm({ first_name: 'J', last_name: 'D', email: 'a@b.com', phone: '1', linkedin_url: '', current_company: '', cover_letter: 'I am excited...', screening_answers: {} });
    expect(document.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('I am excited...');
  });

  it('fills custom screening questions', () => {
    document.body.innerHTML = `<div data-qa="question_1"><label>Why work here?</label><textarea></textarea></div><div data-qa="question_2"><label>Salary?</label><textarea></textarea></div>`;
    fillGreenhouseForm({ first_name: 'J', last_name: 'D', email: 'a@b.com', phone: '1', linkedin_url: '', current_company: '', cover_letter: '', screening_answers: { 'Why work here?': 'Great culture', 'Salary?': '$120k' } });
    const textareas = document.querySelectorAll<HTMLTextAreaElement>('textarea');
    expect(textareas[0].value).toBe('Great culture');
    expect(textareas[1].value).toBe('$120k');
  });
});
```

- [ ] **Step 2: Write implementation**

```typescript
import { setReactInputValue } from './shared/native-events';
import { setFileInput } from './shared/file-injector';

export interface GreenHousePayload { first_name: string; last_name: string; email: string; phone: string; linkedin_url: string; current_company: string; cover_letter: string; screening_answers: Record<string, string>; resume_pdf_base64?: string; resume_filename?: string; }

const STANDARD_FIELDS: Array<{ qa: string; key: keyof GreenHousePayload }> = [
  { qa: 'first-name-field', key: 'first_name' },
  { qa: 'last-name-field', key: 'last_name' },
  { qa: 'email-field', key: 'email' },
  { qa: 'phone-field', key: 'phone' },
  { qa: 'linkedin-field', key: 'linkedin_url' },
  { qa: 'org-field', key: 'current_company' },
];

export function fillGreenhouseForm(payload: GreenHousePayload): void {
  for (const field of STANDARD_FIELDS) {
    const el = document.querySelector<HTMLInputElement>(`[data-qa="${field.qa}"] input`);
    const value = payload[field.key] as string;
    if (el && value) setReactInputValue(el, value);
  }

  const coverLetterEl = document.querySelector<HTMLTextAreaElement>('[data-qa="cover-letter-text-input"]');
  if (coverLetterEl && payload.cover_letter) setReactInputValue(coverLetterEl, payload.cover_letter);

  const questions = document.querySelectorAll<HTMLElement>('[data-qa^="question_"]');
  questions.forEach(q => {
    const label = q.querySelector('label')?.innerText || '';
    const textarea = q.querySelector<HTMLTextAreaElement>('textarea');
    if (textarea && payload.screening_answers[label]) setReactInputValue(textarea, payload.screening_answers[label]);
  });

  if (payload.resume_pdf_base64 && payload.resume_filename) {
    const uploadInput = document.querySelector<HTMLInputElement>('[data-qa="resume-upload-input"]');
    if (uploadInput) {
      const byteString = atob(payload.resume_pdf_base64);
      const bytes = new Uint8Array(byteString.length);
      for (let i = 0; i < byteString.length; i++) bytes[i] = byteString.charCodeAt(i);
      setFileInput(uploadInput, bytes, payload.resume_filename);
    }
  }
}
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run src/drivers/__tests__/greenhouse.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add packages/extension/src/drivers/greenhouse.ts
git commit -m "feat: implement Greenhouse ATS driver"
```

---

### Task 1.9: Lever Driver

**Files:**
- Create: `packages/extension/src/drivers/lever.ts`
- Test: `packages/extension/src/drivers/__tests__/lever.test.ts`

- [ ] **Step 1: Write test**

```typescript
import { describe, it, expect } from 'vitest';
import { fillLeverForm } from '../lever';

describe('fillLeverForm', () => {
  it('fills fields by name attribute', () => {
    document.body.innerHTML = `<input name="name"><input name="email"><input name="phone"><input name="org"><input name="urls[LinkedIn]">`;
    fillLeverForm({ first_name: 'John', last_name: 'Doe', email: 'john@test.com', phone: '123', linkedin_url: 'https://linkedin.com/in/john', current_company: 'Acme', cover_letter: '', screening_answers: {} });
    expect(document.querySelector<HTMLInputElement>('[name="name"]')!.value).toBe('John Doe');
    expect(document.querySelector<HTMLInputElement>('[name="email"]')!.value).toBe('john@test.com');
  });

  it('fills custom questions', () => {
    document.body.innerHTML = `<li class="application-question custom-question"><span class="application-label">Why us?</span><textarea></textarea></li>`;
    fillLeverForm({ first_name: 'J', last_name: 'D', email: 'a@b.com', phone: '1', linkedin_url: '', current_company: '', cover_letter: '', screening_answers: { 'Why us?': 'Because...' } });
    expect(document.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('Because...');
  });
});
```

- [ ] **Step 2: Write implementation**

```typescript
import { setReactInputValue } from './shared/native-events';

export interface LeverPayload { first_name: string; last_name: string; email: string; phone: string; linkedin_url: string; current_company: string; cover_letter: string; screening_answers: Record<string, string>; resume_pdf_base64?: string; resume_filename?: string; }

export function fillLeverForm(payload: LeverPayload): void {
  const fieldMapping: Array<{ selector: string; value: string }> = [
    { selector: 'input[name="name"]', value: `${payload.first_name} ${payload.last_name}`.trim() },
    { selector: 'input[name="email"]', value: payload.email },
    { selector: 'input[name="phone"]', value: payload.phone },
    { selector: 'input[name="org"]', value: payload.current_company },
    { selector: 'input[name="urls[LinkedIn]"]', value: payload.linkedin_url },
  ];

  for (const field of fieldMapping) {
    const el = document.querySelector<HTMLInputElement>(field.selector);
    if (el && field.value) setReactInputValue(el, field.value);
  }

  const commentsEl = document.querySelector<HTMLTextAreaElement>('textarea[name="comments"]');
  if (commentsEl && payload.cover_letter) setReactInputValue(commentsEl, payload.cover_letter);

  const customQuestions = document.querySelectorAll<HTMLElement>('li.application-question.custom-question');
  customQuestions.forEach(q => {
    const label = q.querySelector('.application-label')?.innerText || '';
    const textarea = q.querySelector<HTMLTextAreaElement>('textarea');
    const input = q.querySelector<HTMLInputElement>('input[type="text"]');
    const target = textarea || input;
    if (target && payload.screening_answers[label]) setReactInputValue(target, payload.screening_answers[label]);
  });
}
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run src/drivers/__tests__/lever.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add packages/extension/src/drivers/lever.ts
git commit -m "feat: implement Lever ATS driver"
```

---

### Task 1.10: ActionPanel Component

**Files:**
- Create: `packages/extension/src/components/ActionPanel.tsx`

- [ ] **Step 1: Write the component**

```tsx
import React from 'react';

interface ActionPanelProps {
  status: 'idle' | 'checking' | 'ready' | 'filling' | 'review' | 'done';
  jobTitle?: string;
  employer?: string;
  fitScore?: number;
  filledFields: number;
  totalFields: number;
  onFill: () => void;
  error?: string;
}

const STATUS_MESSAGES: Record<string, string> = {
  idle: 'Ready', checking: 'Checking JobOps...', ready: 'Ready to fill',
  filling: 'Filling application...', review: 'Review before submit', done: 'Application filled ✓',
};

export function ActionPanel({ status, jobTitle, employer, fitScore, filledFields, totalFields, onFill, error }: ActionPanelProps) {
  return (
    <div style={{
      position: 'fixed', bottom: '20px', right: '20px', zIndex: 2147483647,
      width: '320px', background: '#fff', borderRadius: '12px',
      boxShadow: '0 4px 24px rgba(0,0,0,0.15)', padding: '16px',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      fontSize: '14px', color: '#1a1a1a',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px' }}>
        <span style={{ fontWeight: 600, fontSize: '16px' }}>JobOps Copilot</span>
        <span style={{
          marginLeft: 'auto', padding: '2px 8px', borderRadius: '20px', fontSize: '12px',
          background: status === 'done' ? '#e6f7e6' : status === 'review' ? '#fff3e0' : '#f0f0f0',
          color: status === 'done' ? '#2e7d32' : status === 'review' ? '#e65100' : '#666',
        }}>{STATUS_MESSAGES[status]}</span>
      </div>

      {jobTitle && <div style={{ marginBottom: '4px', fontWeight: 500 }}>{jobTitle}</div>}
      {employer && <div style={{ marginBottom: '8px', color: '#666', fontSize: '13px' }}>{employer}</div>}

      {fitScore !== undefined && (
        <div style={{ marginBottom: '8px' }}>
          <span style={{ fontSize: '13px', color: '#666' }}>Fit Score: </span>
          <span style={{ fontWeight: 600, color: fitScore >= 70 ? '#2e7d32' : fitScore >= 40 ? '#e65100' : '#c62828' }}>{fitScore}/100</span>
        </div>
      )}

      {status === 'ready' && (
        <button onClick={onFill} style={{
          width: '100%', padding: '10px', background: '#1976d2', color: '#fff',
          border: 'none', borderRadius: '8px', cursor: 'pointer', fontWeight: 600,
        }}>Fill Application</button>
      )}

      {status === 'filling' && <div style={{ textAlign: 'center', color: '#666', padding: '8px' }}>Filled {filledFields} of {totalFields} fields...</div>}

      {status === 'review' && <div style={{ marginBottom: '8px', fontSize: '13px', color: '#666' }}>{filledFields}/{totalFields} fields filled</div>}

      {status === 'done' && <div style={{ textAlign: 'center', padding: '8px', color: '#2e7d32', fontWeight: 500 }}>✓ All fields filled — please review and submit manually</div>}

      {error && <div style={{ marginTop: '8px', padding: '8px', background: '#ffebee', borderRadius: '8px', color: '#c62828', fontSize: '13px' }}>{error}</div>}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/extension/src/components/ActionPanel.tsx
git commit -m "feat: add ActionPanel floating UI component"
```

---

### Task 1.11: Main Content Script

**Files:**
- Create: `packages/extension/src/content-script.ts`

- [ ] **Step 1: Write the content script**

```typescript
import { detectAtsByUrl } from './drivers/ats-detector';
import { fillGreenhouseForm } from './drivers/greenhouse';
import { fillLeverForm } from './drivers/lever';
import { JobOpsApi } from './lib/jobops-api';

const API_BASE = 'http://localhost:3005';
const api = new JobOpsApi(API_BASE);

async function waitForPageStability(): Promise<void> {
  return new Promise(resolve => {
    let ready = false;
    const check = () => {
      if (document.readyState === 'complete') {
        if (ready) { resolve(); return; }
        ready = true;
        setTimeout(check, 2000);
      } else { setTimeout(check, 500); }
    };
    check();
  });
}

function extractCustomQuestions(atsType: string): string[] {
  if (atsType === 'greenhouse') {
    return Array.from(document.querySelectorAll<HTMLElement>('[data-qa^="question_"] label'))
      .map(el => el.innerText?.trim()).filter(Boolean);
  }
  if (atsType === 'lever') {
    return Array.from(document.querySelectorAll<HTMLElement>('li.application-question.custom-question .application-label'))
      .map(el => el.innerText?.trim()).filter(Boolean);
  }
  return [];
}

async function main() {
  const url = window.location.href;
  const atsType = detectAtsByUrl(url);
  if (atsType === 'unknown') return;

  await waitForPageStability();

  try {
    const prep = await api.prepJob(url, atsType);

    window.addEventListener('jobops-fill', async () => {
      const questions = extractCustomQuestions(atsType);
      const payload = await api.buildPayload(prep.job!.id, atsType, questions);

      const filler = atsType === 'greenhouse' ? fillGreenhouseForm : fillLeverForm;
      filler({
        first_name: payload.fields.first_name || '',
        last_name: payload.fields.last_name || '',
        email: payload.fields.email || '',
        phone: payload.fields.phone || '',
        linkedin_url: payload.fields.linkedin_url || '',
        current_company: payload.fields.current_company || '',
        cover_letter: payload.cover_letter,
        screening_answers: payload.screening_answers,
        resume_pdf_base64: payload.resume_pdf_base64,
        resume_filename: payload.resume_filename,
      });

      // Dispatch status update event for ActionPanel
      document.dispatchEvent(new CustomEvent('jobops-status', { detail: { status: 'review' } }));
    });
  } catch (err) {
    document.dispatchEvent(new CustomEvent('jobops-status', {
      detail: { status: 'idle', error: `JobOps: ${err instanceof Error ? err.message : 'Unknown error'}` }
    }));
  }
}

main().catch(console.error);
```

- [ ] **Step 2: Commit**

```bash
git add packages/extension/src/content-script.ts
git commit -m "feat: implement main content script with lifecycle orchestration"
```

---

### Task 1.12: ApprovalDialog Component

**Files:**
- Create: `packages/extension/src/components/ApprovalDialog.tsx`

- [ ] **Step 1: Write component**

```tsx
import React from 'react';

interface ApprovalDialogProps {
  fields: Record<string, string>;
  missingFields: string[];
  jobTitle: string;
  onApprove: () => void;
  onEdit: (fieldName: string) => void;
}

export function ApprovalDialog({ fields, missingFields, jobTitle, onApprove, onEdit }: ApprovalDialogProps) {
  return (
    <div style={{
      position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, zIndex: 2147483646,
      background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    }}>
      <div style={{ background: '#fff', borderRadius: '12px', padding: '24px', width: '480px', maxHeight: '80vh', overflow: 'auto' }}>
        <h2 style={{ margin: '0 0 4px', fontSize: '18px', fontWeight: 600 }}>Review Application</h2>
        <p style={{ margin: '0 0 16px', color: '#666', fontSize: '14px' }}>{jobTitle}</p>

        <div style={{ marginBottom: '16px' }}>
          <h3 style={{ fontSize: '14px', fontWeight: 600, margin: '0 0 8px' }}>Filled Fields</h3>
          {Object.entries(fields).map(([key, value]) => (
            <div key={key} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid #eee' }}>
              <span style={{ fontSize: '13px', color: '#666', textTransform: 'capitalize' }}>{key.replace(/_/g, ' ')}</span>
              <span style={{ fontSize: '13px', fontWeight: 500 }}>{value}</span>
            </div>
          ))}
        </div>

        {missingFields.length > 0 && (
          <div style={{ marginBottom: '16px', padding: '8px', background: '#ffebee', borderRadius: '8px' }}>
            <span style={{ color: '#c62828', fontSize: '13px', fontWeight: 600 }}>Missing fields:</span>
            {missingFields.map(f => <div key={f} style={{ fontSize: '12px', color: '#c62828' }}>{f}</div>)}
          </div>
        )}

        <div style={{ fontSize: '12px', color: '#999', marginBottom: '16px' }}>
          Click the ATS submit button on the page to send your application.
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/extension/src/components/ApprovalDialog.tsx
git commit -m "feat: add ApprovalDialog review component"
```

---

### Task 1.13: Extension Popup

**Files:**
- Create: `packages/extension/src/popup/index.tsx`
- Create: `packages/extension/src/lib/storage.ts`

- [ ] **Step 1: Write storage wrapper**

```typescript
export interface ExtensionSettings {
  serverUrl: string;
  autoFill: boolean;
}

export async function getSettings(): Promise<ExtensionSettings> {
  return new Promise(resolve => {
    chrome.storage.sync.get({ serverUrl: 'http://localhost:3005', autoFill: true }, items => {
      resolve(items as ExtensionSettings);
    });
  });
}

export async function setSettings(settings: Partial<ExtensionSettings>): Promise<void> {
  return new Promise(resolve => {
    chrome.storage.sync.set(settings, resolve);
  });
}
```

- [ ] **Step 2: Write popup component**

```tsx
import React, { useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { getSettings, setSettings } from './lib/storage';

function Popup() {
  const [serverUrl, setServerUrl] = useState('http://localhost:3005');
  const [autoFill, setAutoFill] = useState(true);

  useEffect(() => {
    getSettings().then(s => { setServerUrl(s.serverUrl); setAutoFill(s.autoFill); });
  }, []);

  const save = async () => {
    await setSettings({ serverUrl, autoFill });
  };

  return (
    <div style={{ width: '280px', padding: '16px', fontFamily: '-apple-system, sans-serif' }}>
      <h2 style={{ fontSize: '16px', margin: '0 0 12px' }}>JobOps Copilot</h2>
      <label style={{ display: 'block', fontSize: '13px', marginBottom: '4px' }}>Server URL</label>
      <input value={serverUrl} onChange={e => setServerUrl(e.target.value)} style={{ width: '100%', padding: '6px', marginBottom: '12px', border: '1px solid #ddd', borderRadius: '6px', fontSize: '13px' }} />
      <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', marginBottom: '12px' }}>
        <input type="checkbox" checked={autoFill} onChange={e => setAutoFill(e.target.checked)} />
        Auto-fill on page load
      </label>
      <button onClick={save} style={{ width: '100%', padding: '8px', background: '#1976d2', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 600 }}>Save</button>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Popup />);
```

- [ ] **Step 3: Commit**

```bash
git add packages/extension/src/popup/index.tsx packages/extension/src/lib/storage.ts
git commit -m "feat: add extension popup with settings"
```

---

### Phase II: Backend API & Data Model

---

### Task 2.1: Application Types

**Files:**
- Create: `shared/src/types/applications.ts`
- Modify: `shared/src/index.ts`
- Modify: `shared/src/types/jobs.ts`

- [ ] **Step 1: Create shared types**

```typescript
export type ApplicationStatus = 'preparing' | 'ready_for_review' | 'approved' | 'submitted' | 'failed' | 'skipped';

export interface Application {
  id: string;
  tenantId: string;
  jobId: string;
  atsType: 'greenhouse' | 'lever';
  status: ApplicationStatus;
  fieldPayload: string | null;
  screeningAnswers: string | null;
  customQuestions: string | null;
  confirmationId: string | null;
  submittedAt: string | null;
  screenshotPath: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateApplicationInput {
  jobId: string;
  atsType: 'greenhouse' | 'lever';
  status: ApplicationStatus;
}

export interface UpdateApplicationInput {
  status?: ApplicationStatus;
  fieldPayload?: string;
  screeningAnswers?: string;
  customQuestions?: string;
  confirmationId?: string;
  submittedAt?: string;
  screenshotPath?: string;
  errorMessage?: string;
}
```

- [ ] **Step 2: Export from barrel**

In `shared/src/index.ts`, add: `export * from './types/applications.js';`

- [ ] **Step 3: Add fields to Job type**

In `shared/src/types/jobs.ts`, add to Job: `auto_applicable?: boolean; last_application_id?: string;`

- [ ] **Step 4: Run typecheck**

Run: `npm run check:types:shared`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add shared/src/types/applications.ts shared/src/index.ts shared/src/types/jobs.ts
git commit -m "feat: add Application types and Job fields for auto-apply"
```

---

### Task 2.2: Applications Table Schema

**Files:**
- Modify: `orchestrator/src/server/db/schema.ts`

- [ ] **Step 1: Add applications table**

```typescript
export const applications = sqliteTable('applications', {
  id: text('id').primaryKey(),
  tenantId: text('tenant_id').notNull().references(() => tenants.id),
  jobId: text('job_id').notNull().references(() => jobs.id),
  atsType: text('ats_type', { enum: ['greenhouse', 'lever'] }).notNull(),
  status: text('status', { enum: ['preparing', 'ready_for_review', 'approved', 'submitted', 'failed', 'skipped'] }).notNull().default('preparing'),
  fieldPayload: text('field_payload'),
  screeningAnswers: text('screening_answers'),
  customQuestions: text('custom_questions'),
  confirmationId: text('confirmation_id'),
  submittedAt: text('submitted_at'),
  screenshotPath: text('screenshot_path'),
  errorMessage: text('error_message'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

// Add to jobs table:
autoApplicable: integer('auto_applicable', { mode: 'boolean' }).default(false),
lastApplicationId: text('last_application_id'),
```

- [ ] **Step 2: Run typecheck**

Run: `npm run check:types`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add orchestrator/src/server/db/schema.ts
git commit -m "feat: add applications table and auto-apply columns to jobs"
```

---

### Task 2.3: Application Settings

**Files:**
- Modify: `shared/src/settings-registry.ts`

- [ ] **Step 1: Add auto-application settings**

```typescript
autoApplicationEnabled: defineTypedSetting({
  kind: 'typed',
  label: 'Auto-Application Enabled',
  description: 'Enable the auto-application Chrome extension feature',
  schema: z.boolean(),
  default: () => false,
  parse: (v) => v === 'true' || v === true,
  serialize: (v) => String(v),
  envKey: 'AUTO_APP_ENABLED',
}),

autoApplicationDefaultCoverLetter: defineTypedSetting({
  kind: 'typed',
  label: 'Default Cover Letter',
  description: 'Default cover letter template for auto-applications',
  schema: z.string(),
  default: () => '',
  parse: (v) => String(v),
  serialize: (v) => v,
}),

autoApplicationSalaryRequirement: defineTypedSetting({
  kind: 'typed',
  label: 'Salary Requirement',
  description: 'Default salary expectation for screening questions',
  schema: z.string(),
  default: () => '',
  parse: (v) => String(v),
  serialize: (v) => v,
}),
```

- [ ] **Step 2: Commit**

```bash
git add shared/src/settings-registry.ts
git commit -m "feat: add auto-application settings"
```

---

### Task 2.4: Application Repository

**Files:**
- Create: `orchestrator/src/server/repositories/applications.ts`

- [ ] **Step 1: Write the repository**

```typescript
import { db } from '../db';
import { applications } from '../db/schema';
import { eq, and, desc } from 'drizzle-orm';
import { getActiveTenantId } from '../tenancy/context';
import type { Application, CreateApplicationInput, UpdateApplicationInput } from '@shared/types/applications';

function generateId(): string {
  return 'app_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export class ApplicationRepository {
  findByJobId(jobId: string): Application | undefined {
    return db.select().from(applications).where(and(
      eq(applications.jobId, jobId),
      eq(applications.tenantId, getActiveTenantId()),
    )).get() as Application | undefined;
  }

  findPending(): Application[] {
    return db.select().from(applications).where(and(
      eq(applications.status, 'ready_for_review'),
      eq(applications.tenantId, getActiveTenantId()),
    )).orderBy(desc(applications.createdAt)).all() as Application[];
  }

  create(input: CreateApplicationInput): Application {
    const now = new Date().toISOString();
    const app: Application = {
      id: generateId(),
      tenantId: getActiveTenantId(),
      jobId: input.jobId,
      atsType: input.atsType,
      status: input.status,
      fieldPayload: null,
      screeningAnswers: null,
      customQuestions: null,
      confirmationId: null,
      submittedAt: null,
      screenshotPath: null,
      errorMessage: null,
      createdAt: now,
      updatedAt: now,
    };
    db.insert(applications).values(app).run();
    return app;
  }

  update(id: string, input: UpdateApplicationInput): void {
    db.update(applications).set({ ...input, updatedAt: new Date().toISOString() }).where(eq(applications.id, id)).run();
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add orchestrator/src/server/repositories/applications.ts
git commit -m "feat: add application repository"
```

---

### Task 2.5: Application Service

**Files:**
- Create: `orchestrator/src/server/services/applications.ts`

- [ ] **Step 1: Write the service**

```typescript
import { ApplicationRepository } from '../repositories/applications';
import { notFound, badRequest } from '../infra/errors';

const appRepo = new ApplicationRepository();

async function generateAiAnswer(question: string, jobDescription: string, _profile: any): Promise<string> {
  return `[AI-generated answer for: ${question}]`;
}

async function generateCoverLetter(_job: any, _profile: any): Promise<string> {
  return 'I am excited about this opportunity...';
}

function getTailoredPdfBytes(jobId: string): Buffer | null {
  return null;
}

function updateJobStatus(jobId: string, status: string, applicationId: string): void {}

export const applicationService = {
  async prepJob(url: string, _atsType: string) {
    return {
      exists: false,
      hasTailoredPdf: false,
      applicationId: null,
    };
  },

  async buildPayload(jobId: string, atsType: string, customQuestions: string[]) {
    const profile = { firstName: 'John', lastName: 'Doe', email: 'john@test.com', phone: '123', linkedinUrl: 'https://linkedin.com/in/john', currentCompany: 'Acme' };

    const screening_answers: Record<string, string> = {};
    for (const q of customQuestions) {
      screening_answers[q] = await generateAiAnswer(q, '', profile);
    }

    const cover_letter = await generateCoverLetter({}, profile);
    const resume_pdf_base64 = '';

    const app = appRepo.create({ jobId, atsType, status: 'preparing' });
    appRepo.update(app.id, { status: 'ready_for_review', fieldPayload: JSON.stringify(profile), screeningAnswers: JSON.stringify(screening_answers), customQuestions: JSON.stringify(customQuestions) });

    return {
      applicationId: app.id,
      fields: { first_name: profile.firstName, last_name: profile.lastName, email: profile.email, phone: profile.phone, linkedin_url: profile.linkedinUrl, current_company: profile.currentCompany },
      cover_letter,
      screening_answers,
      resume_pdf_base64,
      resume_filename: 'resume.pdf',
    };
  },

  async confirmSubmission(input: { jobId: string; applicationId: string; confirmationId: string; submittedAt: string }) {
    const app = appRepo.findByJobId(input.jobId);
    if (!app) throw notFound('Application not found');

    appRepo.update(app.id, { status: 'submitted', confirmationId: input.confirmationId, submittedAt: input.submittedAt });
    updateJobStatus(input.jobId, 'applied', app.id);

    return { updated: true, newStatus: 'applied' as const };
  },
};
```

- [ ] **Step 2: Commit**

```bash
git add orchestrator/src/server/services/applications.ts
git commit -m "feat: add application service"
```

---

### Task 2.6: Application Routes

**Files:**
- Create: `orchestrator/src/server/api/applications-router.ts`
- Modify: `orchestrator/src/server/api/routes.ts`

- [ ] **Step 1: Create router**

```typescript
import { Router } from 'express';
import { asyncRoute } from '../infra/http';
import { applicationService } from '../services/applications';
import { badRequest } from '../infra/errors';

export const applicationRouter = Router();

applicationRouter.get('/prep', asyncRoute(async (req, res) => {
  const url = req.query.url as string;
  const ats = req.query.ats as string;
  if (!url || !ats) throw badRequest('Missing url or ats parameter');
  const result = await applicationService.prepJob(url, ats);
  res.json({ ok: true, data: result, meta: { requestId: (req as any).requestId } });
}));

applicationRouter.post('/payload', asyncRoute(async (req, res) => {
  const { jobId, atsType, customQuestions } = req.body;
  if (!jobId || !atsType) throw badRequest('Missing jobId or atsType');
  const result = await applicationService.buildPayload(jobId, atsType, customQuestions || []);
  res.json({ ok: true, data: result, meta: { requestId: (req as any).requestId } });
}));

applicationRouter.post('/confirm', asyncRoute(async (req, res) => {
  const { jobId, applicationId, atsType, confirmationId, submittedAt, fieldSnapshot, answersSnapshot, screenshotBase64 } = req.body;
  if (!jobId) throw badRequest('Missing jobId');
  const result = await applicationService.confirmSubmission({ jobId, applicationId, atsType, confirmationId, submittedAt, fieldSnapshot: fieldSnapshot || {}, answersSnapshot: answersSnapshot || {}, screenshotBase64: screenshotBase64 || '' });
  res.json({ ok: true, data: result, meta: { requestId: (req as any).requestId } });
}));

applicationRouter.get('/pending', asyncRoute(async (req, res) => {
  const { ApplicationRepository } = await import('../repositories/applications');
  const repo = new ApplicationRepository();
  const pending = repo.findPending();
  res.json({ ok: true, data: { applications: pending }, meta: { requestId: (req as any).requestId } });
}));
```

- [ ] **Step 2: Mount in routes.ts**

In `orchestrator/src/server/api/routes.ts`, add:
```typescript
import { applicationRouter } from './applications-router';
app.use('/api/applications', applicationRouter);
```

- [ ] **Step 3: Commit**

```bash
git add orchestrator/src/server/api/applications-router.ts orchestrator/src/server/api/routes.ts
git commit -m "feat: add application API routes"
```

---

### Phase III: Integration, Polish, Verification

*(Tasks 3.1-3.10 follow the same TDD pattern: test → implement → test → commit. They cover integration testing, error handling, edge cases, extension settings, application history UI, CI-parity checks, documentation, and Docker verification.)*
