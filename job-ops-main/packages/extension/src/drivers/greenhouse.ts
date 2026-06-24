import { setFileInput } from "./shared/file-injector";
import { setReactInputValue } from "./shared/native-events";

export interface GreenHousePayload {
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
  linkedin_url: string;
  current_company: string;
  cover_letter: string;
  screening_answers: Record<string, string>;
  resume_pdf_base64?: string;
  resume_filename?: string;
}

const STANDARD_FIELDS: Array<{ qa: string; key: keyof GreenHousePayload }> = [
  { qa: "first-name-field", key: "first_name" },
  { qa: "last-name-field", key: "last_name" },
  { qa: "email-field", key: "email" },
  { qa: "phone-field", key: "phone" },
  { qa: "linkedin-field", key: "linkedin_url" },
  { qa: "org-field", key: "current_company" },
];

export function fillGreenhouseForm(payload: GreenHousePayload): {
  missingFields: string[];
} {
  const missingFields: string[] = [];

  for (const field of STANDARD_FIELDS) {
    const el = document.querySelector<HTMLInputElement>(
      `[data-qa="${field.qa}"] input`,
    );
    const value = payload[field.key] as string;
    if (el && value) setReactInputValue(el, value);
    if (!value) missingFields.push(field.key);
  }

  const coverLetterEl = document.querySelector<HTMLTextAreaElement>(
    '[data-qa="cover-letter-text-input"]',
  );
  if (coverLetterEl && payload.cover_letter)
    setReactInputValue(coverLetterEl, payload.cover_letter);
  if (!payload.cover_letter) missingFields.push("cover_letter");

  const questions = document.querySelectorAll<HTMLElement>(
    '[data-qa^="question_"]',
  );
  questions.forEach((q) => {
    const label = q.querySelector("label")?.textContent?.trim() || "";
    const answer = payload.screening_answers[label];

    const selectEl = q.querySelector<HTMLSelectElement>("select");
    if (selectEl && answer) {
      const option = Array.from(selectEl.options).find((o) =>
        o.text.toLowerCase().includes(answer.toLowerCase().slice(0, 10)),
      );
      if (option) {
        selectEl.value = option.value;
        selectEl.dispatchEvent(new Event("change", { bubbles: true }));
      }
    } else if (selectEl && !answer) {
      missingFields.push(label);
    } else {
      const textarea = q.querySelector<HTMLTextAreaElement>("textarea");
      if (textarea && answer) {
        setReactInputValue(textarea, answer);
      } else if (label && !answer) {
        missingFields.push(label);
      }
    }
  });

  if (payload.resume_pdf_base64 && payload.resume_filename) {
    const uploadInput = document.querySelector<HTMLInputElement>(
      '[data-qa="resume-upload-input"]',
    );
    if (uploadInput) {
      try {
        const byteString = atob(payload.resume_pdf_base64);
        const bytes = new Uint8Array(byteString.length);
        for (let i = 0; i < byteString.length; i++)
          bytes[i] = byteString.charCodeAt(i);
        setFileInput(uploadInput, bytes, payload.resume_filename);
      } catch {
        console.error("JobOps: Failed to decode resume PDF base64");
      }
    }
  }

  if (missingFields.length > 0) {
    console.warn("JobOps: Unfilled fields:", missingFields);
  }

  return { missingFields };
}
