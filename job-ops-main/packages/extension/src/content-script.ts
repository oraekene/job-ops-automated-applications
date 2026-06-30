import { detectAtsByUrl } from "./drivers/ats-detector";
import { fillGreenhouseForm } from "./drivers/greenhouse";
import { fillLeverForm } from "./drivers/lever";
import {
  setReactInputValue,
} from "./drivers/shared/native-events";
import { uploadResume } from "./drivers/shared/file-injector";
import { detectBlocker } from "./lib/detect-blocker";
import type { JobopsResult, PayloadResponse } from "./lib/jobops-api";
import { ApiError, JobOpsApi, NetworkError } from "./lib/jobops-api";
import {
  extractEmployerName,
  extractJobDescription,
  extractJobTitle,
} from "./lib/page-extractor";
import { getSettings, type ExtensionSettings } from "./lib/storage";

let api: JobOpsApi;
let settings: ExtensionSettings | null = null;

async function ensureApi(): Promise<JobOpsApi> {
  if (!api) {
    settings = await getSettings();
    api = new JobOpsApi(settings.serverUrl || "http://localhost:3001");
  }
  return api;
}

let panelShadow: ShadowRoot | null = null;

function createPanelHTML(): HTMLDivElement {
  const wrapper = document.createElement("div");
  wrapper.id = "jobops-panel";
  wrapper.style.cssText = "all:initial;";
  panelShadow = wrapper.attachShadow({ mode: "closed" });
  panelShadow.innerHTML = `
<div id="root" style="position:fixed;bottom:20px;right:20px;z-index:2147483647;width:320px;background:#fff;border-radius:12px;box-shadow:0 4px 24px rgba(0,0,0,0.15);padding:16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:14px;color:#1a1a1a;">
  <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;">
    <span style="font-weight:600;font-size:16px;">JobOps Copilot</span>
    <span id="badge" style="margin-left:auto;padding:2px 8px;border-radius:20px;font-size:12px;background:#f0f0f0;color:#666;">Loading</span>
  </div>
  <div id="body">
    <div style="text-align:center;color:#666;padding:8px;">Initializing...</div>
  </div>
</div>`;
  return wrapper;
}

function getShadowRoot(): ShadowRoot | null {
  return panelShadow;
}

function updatePanel(
  body: string,
  badgeText?: string,
  badgeBg?: string,
  badgeColor?: string,
) {
  const shadow = getShadowRoot();
  if (!shadow) return;
  const bodyEl = shadow.getElementById("body");
  if (bodyEl) bodyEl.innerHTML = body;
  const badgeEl = shadow.getElementById("badge");
  if (badgeEl) {
    badgeEl.textContent = badgeText || "";
    badgeEl.style.background = badgeBg || "#f0f0f0";
    badgeEl.style.color = badgeColor || "#666";
  }
}

function ensurePanelInjected(): boolean {
  if (document.getElementById("jobops-panel")) return true;
  const panel = createPanelHTML();
  document.documentElement.appendChild(panel);
  return false;
}

function showReadyPanel(jobTitle: string, employer: string, score?: number) {
  ensurePanelInjected();
  updatePanel(
    `
    ${jobTitle ? `<div style="margin-bottom:4px;font-weight:500;">${escapeHtml(jobTitle)}</div>` : ""}
    ${employer ? `<div style="margin-bottom:8px;color:#666;font-size:13px;">${escapeHtml(employer)}</div>` : ""}
    ${score !== undefined ? `<div style="margin-bottom:8px;"><span style="font-size:13px;color:#666;">Fit Score: </span><span style="font-weight:600;color:${score >= 70 ? "#2e7d32" : score >= 40 ? "#e65100" : "#c62828"};">${score}/100</span></div>` : ""}
    <button id="fill-btn" style="width:100%;padding:10px;background:#1976d2;color:#fff;border:none;border-radius:8px;cursor:pointer;font-weight:600;font-size:14px;">Fill Application</button>
    <div style="margin-top:8px;font-size:11px;color:#999;text-align:center;">Powered by JobOps</div>
  `,
    "Ready",
    "#e3f2fd",
    "#1565c0",
  );

  const shadow = getShadowRoot();
  shadow?.getElementById("fill-btn")?.addEventListener("click", () => {
    updatePanel(
      '<div style="text-align:center;color:#666;padding:8px;">Filling application...</div>',
      "Filling",
      "#fff3e0",
      "#e65100",
    );
    setTimeout(doFill, 100);
  });
}

function showOfflinePanel() {
  ensurePanelInjected();
  updatePanel(
    `
    <div style="margin-bottom:8px;font-size:13px;color:#c62828;">Server offline</div>
    <button id="fill-btn" style="width:100%;padding:10px;background:#1976d2;color:#fff;border:none;border-radius:8px;cursor:pointer;font-weight:600;font-size:14px;">Demo: Fill Form</button>
    <div style="margin-top:8px;font-size:11px;color:#999;">Fills with demo placeholder data for visual testing</div>
  `,
    "Demo",
    "#fff3e0",
    "#e65100",
  );

  const shadow = getShadowRoot();
  shadow?.getElementById("fill-btn")?.addEventListener("click", () => {
    updatePanel(
      '<div style="text-align:center;color:#666;padding:8px;">Filling application...</div>',
      "Filling",
      "#fff3e0",
      "#e65100",
    );
    setTimeout(doFill, 100);
  });
}

function escapeHtml(text: string): string {
  const d = document.createElement("div");
  d.textContent = text;
  return d.innerHTML;
}

async function waitForPageStability(): Promise<void> {
  if (document.readyState !== "complete") {
    await new Promise<void>((resolve) => {
      document.addEventListener(
        "readystatechange",
        () => {
          resolve();
        },
        { once: true },
      );
    });
  }
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 2000);
  });
}

function doFill() {
  console.log("JobOps: fill triggered");
  void runDoFill();
}

export function extractJobIdFromUrl(
  url: string,
  atsType?: string | null,
): string | null {
  try {
    const parsed = new URL(url);
    const fromQuery = parsed.searchParams.get("jobId");
    if (fromQuery) return fromQuery;
    if (parsed.hash.startsWith("#jobId=")) {
      return parsed.hash.slice("#jobId=".length);
    }
    if (atsType === "greenhouse") {
      const m = parsed.pathname.match(/\/jobs\/(\d+)/);
      if (m?.[1]) return m[1];
    }
    if (atsType === "lever") {
      const segments = parsed.pathname.split("/").filter(Boolean);
      if (segments.length >= 2) {
        const last = segments[segments.length - 1];
        if (last === "apply" && segments.length >= 3) {
          return segments[segments.length - 2];
        }
        if (/^[a-f0-9-]{20,}$/i.test(last)) return last;
      }
    }
    return null;
  } catch {
    return null;
  }
}

export function reportResult(
  jobId: string | null,
  outcome: "submitted" | "skipped" | "failed",
  extras: {
    reason?: string;
    confirmationId?: string;
    fieldSnapshot?: Record<string, string>;
    answersSnapshot?: Record<string, string>;
    screenshotBase64?: string;
  } = {},
): void {
  try {
    const result: JobopsResult = {
      kind: "jobops:result",
      jobId: jobId ?? "unknown",
      outcome,
      ...extras,
    };
    chrome.runtime.sendMessage(result);
  } catch (err) {
    console.log("JobOps: failed to send result message", err);
  }
}

export function extractConfirmationId(): string | null {
  try {
    const parsed = new URL(window.location.href);
    const ghJid = parsed.searchParams.get("gh_jid");
    if (ghJid) return ghJid;
    const confirmMatch = parsed.pathname.match(/\/confirmation\/([^/]+)/);
    if (confirmMatch?.[1]) return confirmMatch[1];
  } catch {
    // ignore
  }
  const text = document.body?.innerText ?? "";
  if (/Your application has been submitted/i.test(text)) {
    const el = document.querySelector("[data-confirmation-id]");
    const attr = el?.getAttribute("data-confirmation-id");
    if (attr) return attr;
  }
  return null;
}

export async function runDoFill(): Promise<void> {
  const url = window.location.href;
  const atsType = detectAtsByUrl(url);
  const jobId = extractJobIdFromUrl(url, atsType);
  const customQuestions = _extractCustomQuestions(atsType);
  ensurePanelInjected();

  const jobTitle = extractJobTitle(atsType);
  const employer = extractEmployerName(atsType);
  const description = extractJobDescription(atsType);

  if (atsType === "unknown") {
    reportResult(jobId, "skipped", { reason: "unknown ATS" });
    updatePanel(
      '<div style="text-align:center;color:#c62828;font-weight:500;padding:8px;">Unknown ATS \u2014 cannot fill.</div>',
      "Skip",
      "#ffebee",
      "#c62828",
    );
    return;
  }

  if (!jobId) {
    reportResult(jobId, "skipped", { reason: "missing jobId" });
    updatePanel(
      '<div style="text-align:center;color:#c62828;font-weight:500;padding:8px;">Missing jobId \u2014 cannot fill.</div>',
      "Skip",
      "#ffebee",
      "#c62828",
    );
    return;
  }

  let payload: PayloadResponse;
  try {
    const jApi = await ensureApi();
    payload = await jApi.buildPayload(jobId, atsType, customQuestions, {
      jobTitle,
      employer,
      description,
    });
  } catch (err) {
    if (err instanceof ApiError) {
      if (err.status === 404) {
        reportResult(jobId, "skipped", { reason: "profile missing" });
        updatePanel(
          '<div style="text-align:center;color:#c62828;font-weight:500;padding:8px;">Complete onboarding first \u2014 profile not found.</div>',
          "Skip",
          "#ffebee",
          "#c62828",
        );
        return;
      }
      if (err.status === 422) {
        const reason = err.message || "unprocessable";
        reportResult(jobId, "skipped", { reason });
        updatePanel(
          `<div style="text-align:center;color:#e65100;font-weight:500;padding:8px;">Skipped: ${escapeHtml(reason)}</div>`,
          "Skip",
          "#fff3e0",
          "#e65100",
        );
        return;
      }
      if (err.status >= 500) {
        reportResult(jobId, "skipped", { reason: "server error" });
        updatePanel(
          '<div style="text-align:center;color:#e65100;font-weight:500;padding:8px;">Skipped: server error</div>',
          "Skip",
          "#fff3e0",
          "#e65100",
        );
        return;
      }
      reportResult(jobId, "skipped", {
        reason: err.message,
        error: { code: err.code, message: err.message },
      });
      updatePanel(
        `<div style="text-align:center;color:#e65100;font-weight:500;padding:8px;">Skipped: ${escapeHtml(err.message)}</div>`,
        "Skip",
        "#fff3e0",
        "#e65100",
      );
      return;
    }
    if (err instanceof NetworkError) {
      reportResult(jobId, "skipped", { reason: "network error" });
      updatePanel(
        '<div style="text-align:center;color:#e65100;font-weight:500;padding:8px;">Skipped: network error</div>',
        "Skip",
        "#fff3e0",
        "#e65100",
      );
      return;
    }
    reportResult(jobId, "failed", {
      reason: "unexpected error",
      error: {
        code: "UNEXPECTED",
        message: err instanceof Error ? err.message : String(err),
      },
    });
    updatePanel(
      '<div style="text-align:center;color:#c62828;font-weight:500;padding:8px;">Fill failed \u2014 unexpected error.</div>',
      "Failed",
      "#ffebee",
      "#c62828",
    );
    return;
  }

  try {
    populateAtsForm(payload, atsType);
  } catch (err) {
    console.log("JobOps: populateAtsForm threw", err);
  }

  const missingQuestions = payload.missingQuestions;
  if (missingQuestions && missingQuestions.length > 0) {
    highlightMissingFields(atsType, missingQuestions);
    reportResult(jobId, "incomplete", {
      reason: `Missing ${missingQuestions.length} question(s): ${missingQuestions.join("; ")}`,
    });
    updatePanel(
      `<div style="text-align:center;font-size:13px;color:#e65100;font-weight:500;padding:8px;">Filled ${payload.screening_answers ? Object.keys(payload.screening_answers).length : 0} of ${customQuestions.length} questions. ${missingQuestions.length} highlighted field(s) need your input.</div>`,
      "Incomplete",
      "#fff3e0",
      "#e65100",
    );
    return;
  }

  const resumeInput = findResumeUploadInput(atsType);
  const uploaded = await uploadResume(
    resumeInput,
    payload.resume_pdf_base64,
    payload.resume_filename,
  );
  if (!uploaded) {
    reportResult(jobId, "skipped", { reason: "no resume upload input" });
    updatePanel(
      '<div style="text-align:center;color:#e65100;font-weight:500;padding:8px;">No resume upload field on this form \u2014 skipped.</div>',
      "Skip",
      "#fff3e0",
      "#e65100",
    );
    return;
  }

  reportResult(jobId, "submitted", {
    confirmationId: extractConfirmationId() ?? undefined,
    fieldSnapshot: payload.fields,
    answersSnapshot: payload.screening_answers,
  });
  updatePanel(
    '<div style="text-align:center;font-size:13px;color:#2e7d32;font-weight:500;">\u2713 Fields filled. Please review and submit manually.</div>',
    "Review",
    "#e6f7e6",
    "#2e7d32",
  );
  startConfirmationMonitoring();
}

/**
 * Find the ATS-specific file input for the tailored resume.
 * Greenhouse exposes a stable data-qa selector; Lever has no resume upload
 * field in its standard application form, so it returns null.
 */
function findResumeUploadInput(atsType: string): HTMLInputElement | null {
  if (atsType === "greenhouse") {
    return (
      document.querySelector<HTMLInputElement>(
        'input[data-qa="resume-upload-input"]',
      ) ??
      document.querySelector<HTMLInputElement>('input#resume[type="file"]') ??
      document.querySelector<HTMLInputElement>(
        '.file-upload input[type="file"]',
      ) ??
      document.querySelector<HTMLInputElement>(
        '.application--questions input[type="file"]',
      ) ??
      document.querySelector<HTMLInputElement>('input[type="file"]')
    );
  }
  if (atsType === "lever") {
    return document.querySelector<HTMLInputElement>('input[type="file"]');
  }
  return null;
}

export function populateAtsForm(
  payload: PayloadResponse,
  atsType: string,
): void {
  const atsFiller =
    atsType === "greenhouse" ? fillGreenhouseForm : fillLeverForm;
  try {
    atsFiller({
      ...payload.fields,
      cover_letter: payload.cover_letter,
      salary: payload.fields.salary,
      screening_answers: payload.screening_answers,
    });
  } catch (err) {
    console.log("JobOps: ATS driver error, using fallback:", err);
  }
  _fillCustomQuestions(atsType, payload.screening_answers ?? {});
  fillFormByLabels({
    ...payload.fields,
    cover_letter: payload.cover_letter,
    salary: payload.fields.salary ?? "",
  });
}

function _fillCustomQuestions(
  atsType: string,
  screeningAnswers: Record<string, string>,
): void {
  const questions = _extractCustomQuestions(atsType);
  if (questions.length === 0) return;

  let containers: NodeListOf<HTMLElement> | null = null;
  let labelSelector: string | null = null;
  if (atsType === "greenhouse") {
    containers = document.querySelectorAll<HTMLElement>(
      '[data-qa^="question_"]',
    );
    labelSelector = "label";
    if (containers.length === 0) {
      containers = document.querySelectorAll<HTMLElement>(
        '.application--questions .field-wrapper:not([data-qa])',
      );
      labelSelector = ".label";
    }
  } else if (atsType === "lever") {
    containers = document.querySelectorAll<HTMLElement>(
      "li.application-question.custom-question",
    );
    labelSelector = ".application-label";
  }
  if (!containers || !labelSelector) return;

  for (const questionText of questions) {
    const answer = screeningAnswers[questionText];
    if (!answer) continue;

    let container: HTMLElement | null = null;
    for (const el of Array.from(containers)) {
      const label = el.querySelector(labelSelector)?.textContent?.trim();
      if (label === questionText) {
        container = el;
        break;
      }
    }
    if (!container) continue;

    const selectEl = container.querySelector<HTMLSelectElement>("select");
    if (selectEl) {
      const option = Array.from(selectEl.options).find((o) =>
        o.text.toLowerCase().includes(answer.toLowerCase().slice(0, 10)),
      );
      if (option) {
        selectEl.value = option.value;
        selectEl.dispatchEvent(new Event("change", { bubbles: true }));
      }
      continue;
    }

    const target = container.querySelector<
      HTMLInputElement | HTMLTextAreaElement
    >('textarea, input[type="text"]');
    if (!target) continue;

    const proto =
      target instanceof HTMLTextAreaElement
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (!setter) {
      target.value = answer;
      continue;
    }
    setter.call(target, answer);
    target.dispatchEvent(new Event("input", { bubbles: true }));
    target.dispatchEvent(new Event("change", { bubbles: true }));
  }
}

function highlightMissingFields(
  atsType: string,
  missingQuestions: string[],
): void {
  if (missingQuestions.length === 0) return;

  let containers: NodeListOf<HTMLElement> | null = null;
  let labelSelector: string | null = null;
  if (atsType === "greenhouse") {
    containers = document.querySelectorAll<HTMLElement>(
      '[data-qa^="question_"]',
    );
    labelSelector = "label";
    if (containers.length === 0) {
      containers = document.querySelectorAll<HTMLElement>(
        '.application--questions .field-wrapper:not([data-qa])',
      );
      labelSelector = ".label";
    }
  } else if (atsType === "lever") {
    containers = document.querySelectorAll<HTMLElement>(
      "li.application-question.custom-question",
    );
    labelSelector = ".application-label";
  }
  if (!containers || !labelSelector) return;

  for (const questionText of missingQuestions) {
    let container: HTMLElement | null = null;
    for (const el of Array.from(containers)) {
      const label = el.querySelector(labelSelector)?.textContent?.trim();
      if (label === questionText) {
        container = el;
        break;
      }
    }
    if (!container) continue;

    container.style.border = "2px solid #e53935";
    container.style.borderRadius = "4px";
    container.style.background = "#fff5f5";
    container.style.padding = "4px";

    const target = container.querySelector<
      HTMLInputElement | HTMLTextAreaElement
    >('textarea, input[type="text"], select');
    if (target) {
      target.style.borderColor = "#e53935";
      target.style.background = "#fff0f0";
    }

    container.scrollIntoView({ behavior: "smooth", block: "center" });
  }
}

function fillFormByLabels(data: Record<string, string>): { filled: number } {
  const LABEL_MAP: Record<string, string> = {
    "first name": "first_name",
    "last name": "last_name",
    email: "email",
    phone: "phone",
    linkedin: "linkedin_url",
    "linkedin profile": "linkedin_url",
    company: "current_company",
    "current company": "current_company",
    "cover letter": "cover_letter",
    "additional information": "cover_letter",
    salary: "salary",
    "salary expectations": "salary",
    website: "website_url",
    "website url": "website_url",
    relocation: "relocation",
    "open to relocation": "relocation",
    "visa sponsorship": "visa_sponsorship",
    "visa": "visa_sponsorship",
    "work authorization": "work_authorization",
    "authorized to work": "work_authorization",
    "ai policy": "ai_policy",
    "in-person": "work_location",
    "working in-person": "work_location",
    "work location": "work_location",
    "pronounce": "name_pronunciation",
    "pronunciation": "name_pronunciation",
  };

  let filled = 0;

  const fields = document.querySelectorAll<HTMLElement>(
    'input:not([type="hidden"]):not([type="file"]):not([type="submit"]):not([type="checkbox"]):not([type="radio"]), textarea, select',
  );
  fields.forEach((field) => {
    const label = findLabel(field);
    if (!label) return;

    const labelLower = label.toLowerCase().trim();
    for (const [pattern, key] of Object.entries(LABEL_MAP)) {
      if (labelLower.includes(pattern) && data[key]) {
        if (field instanceof HTMLSelectElement) {
          const option = Array.from(field.options).find((o) =>
            o.text.toLowerCase().includes(data[key].toLowerCase().slice(0, 10)),
          );
          if (option) {
            field.value = option.value;
            field.dispatchEvent(new Event("change", { bubbles: true }));
            filled++;
          }
        } else {
          const input = field as HTMLInputElement | HTMLTextAreaElement;
          const proto =
            input.tagName === "TEXTAREA"
              ? HTMLTextAreaElement.prototype
              : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
          if (setter) {
            setter.call(input, data[key]);
            input.dispatchEvent(new Event("input", { bubbles: true }));
            input.dispatchEvent(new Event("change", { bubbles: true }));
            filled++;
          }
        }
        break;
      }
    }
  });

  return { filled };
}

function findLabel(el: HTMLElement): string | null {
  const id = el.id;
  if (id) {
    const label = document.querySelector<HTMLLabelElement>(
      `label[for="${id}"]`,
    );
    if (label) return label.innerText;
  }
  let parent = el.parentElement;
  for (let i = 0; i < 5 && parent; i++) {
    const label = parent.querySelector<HTMLElement>(
      ":scope > label, :scope > span, :scope > div",
    );
    if (label && label !== el) {
      const text = label.innerText?.trim();
      if (text) return text;
    }
    parent = parent.parentElement;
  }
  const ariaLabel = el.getAttribute("aria-label");
  if (ariaLabel) return ariaLabel;
  const placeholder = el.getAttribute("placeholder");
  if (placeholder) return placeholder;
  return null;
}

function _extractCustomQuestions(atsType: string): string[] {
  if (atsType === "greenhouse") {
    const standardQuestions = Array.from(
      document.querySelectorAll<HTMLElement>('[data-qa^="question_"] label'),
    )
      .map((el) => el.textContent?.trim())
      .filter(Boolean) as string[];
    if (standardQuestions.length > 0) return standardQuestions;

    return Array.from(
      document.querySelectorAll<HTMLElement>(
        '.application--questions .field-wrapper:not([data-qa]) label.label',
      ),
    )
      .map((el) => el.textContent?.trim())
      .filter(Boolean) as string[];
  }
  if (atsType === "lever") {
    return Array.from(
      document.querySelectorAll<HTMLElement>(
        "li.application-question.custom-question .application-label",
      ),
    )
      .map((el) => el.textContent?.trim())
      .filter(Boolean) as string[];
  }
  return [];
}

function startConfirmationMonitoring(): void {
  let settled = false;
  function done(_confirmationId?: string): void {
    if (settled) return;
    settled = true;
    updatePanel(
      '<div style="text-align:center;padding:8px;color:#2e7d32;font-weight:500;">✓ Application submitted successfully!</div>',
      "Done",
      "#e6f7e6",
      "#2e7d32",
    );
  }
  function fallback(): void {
    if (settled) return;
    settled = true;
    updatePanel(
      '<div style="text-align:center;padding:8px;color:#e65100;font-weight:500;">Did the submission go through?</div><button id="confirm-btn" style="width:100%;padding:8px;background:#2e7d32;color:#fff;border:none;border-radius:8px;cursor:pointer;font-weight:600;margin-top:8px;">Confirm</button>',
      "Pending",
      "#fff3e0",
      "#e65100",
    );
    const shadow = getShadowRoot();
    shadow
      ?.getElementById("confirm-btn")
      ?.addEventListener("click", () => done());
  }
  function checkUrl(): boolean {
    if (
      /^\/(confirmation|thank-you|apply\/success)/i.test(
        window.location.pathname,
      )
    ) {
      done();
      return true;
    }
    return false;
  }
  function checkDom(): boolean {
    const text = document.body?.innerText ?? "";
    if (
      /\b(?:Your application has been submitted|Thank you for applying|Application received)\b/i.test(
        text,
      )
    ) {
      done();
      return true;
    }
    return false;
  }
  if (checkUrl() || checkDom()) return;
  const observer = new MutationObserver(() => {
    if (checkUrl() || checkDom()) observer.disconnect();
  });
  observer.observe(document.body, { childList: true, subtree: true });
  setTimeout(() => {
    observer.disconnect();
    fallback();
  }, 30000);
}

async function main() {
  console.log("JobOps: content script loaded on", window.location.href);
  const url = window.location.href;
  const atsType = detectAtsByUrl(url);
  console.log("JobOps: detected ATS:", atsType);
  if (atsType === "unknown") {
    console.log("JobOps: unknown ATS, exiting");
    return;
  }

  ensurePanelInjected();

  await waitForPageStability();

  const jApi = await ensureApi();
  const serverUrl = settings?.serverUrl || "http://localhost:3001";

  if (settings?.blockerDetection !== false) {
    const blocker = detectBlocker();
    if (blocker.blocked) {
      const jobId = extractJobIdFromUrl(url, atsType);
      reportResult(jobId, "skipped", { reason: blocker.reason });
      updatePanel(
        `<div style="text-align:center;color:#c62828;font-weight:500;padding:8px;">${escapeHtml(blocker.reason ?? "Blocked")} \u2014 skipping.</div>`,
        "Skip",
        "#ffebee",
        "#c62828",
      );
      return;
    }
  }

  const FORCE_PANEL_TIMEOUT = 5000;
  let panelShown = false;

  setTimeout(() => {
    if (!panelShown) {
      console.log("JobOps: server timeout, showing demo panel");
      panelShown = true;
      showOfflinePanel();
    }
  }, FORCE_PANEL_TIMEOUT);

  try {
    console.log("JobOps: calling server at", serverUrl);
    const prep = await jApi.prepJob(url, atsType);
    if (panelShown) return;
    panelShown = true;
    console.log("JobOps: server responded", prep);
    showReadyPanel(
      prep.job?.title || "",
      prep.job?.employer || "",
      prep.job?.suitabilityScore,
    );

    // Check sync settings first, then fall back to popup's local storage key
    const autoApply = settings?.autoApplyEnabled || await new Promise<boolean>((resolve) => {
      chrome.storage.local.get("autoApply.enabled", (data) => {
        resolve(Boolean((data as Record<string, unknown>)?.["autoApply.enabled"]));
      });
    });
    if (autoApply) {
      console.log("JobOps: auto-apply enabled, filling automatically");
      setTimeout(doFill, 500);
    } else if (settings?.autoFill !== false) {
      console.log("JobOps: auto-fill enabled, filling automatically");
      setTimeout(doFill, 500);
    }
  } catch (err) {
    if (panelShown) return;
    panelShown = true;
    console.log("JobOps: server error, showing demo:", err);
    showOfflinePanel();
  }
}

main().catch(console.error);
