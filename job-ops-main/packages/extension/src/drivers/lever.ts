import { setFileInput } from "./shared/file-injector";
import { setReactInputValue } from "./shared/native-events";

export interface LeverPayload {
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

export function fillLeverForm(payload: LeverPayload): {
  missingFields: string[];
} {
  const missingFields: string[] = [];

  const fullName = `${payload.first_name} ${payload.last_name}`.trim();
  if (!payload.first_name) missingFields.push("first_name");
  if (!payload.last_name) missingFields.push("last_name");

  const fieldMapping: Array<{ selector: string; value: string }> = [
    { selector: 'input[name="name"]', value: fullName },
    { selector: 'input[name="email"]', value: payload.email },
    { selector: 'input[name="phone"]', value: payload.phone },
    { selector: 'input[name="org"]', value: payload.current_company },
    { selector: 'input[name="urls[LinkedIn]"]', value: payload.linkedin_url },
  ];

  for (const field of fieldMapping) {
    const el = document.querySelector<HTMLInputElement>(field.selector);
    if (el && field.value) setReactInputValue(el, field.value);
  }

  if (!payload.email) missingFields.push("email");
  if (!payload.phone) missingFields.push("phone");
  if (!payload.linkedin_url) missingFields.push("linkedin_url");
  if (!payload.current_company) missingFields.push("current_company");

  const commentsEl = document.querySelector<HTMLTextAreaElement>(
    'textarea[name="comments"]',
  );
  if (commentsEl && payload.cover_letter)
    setReactInputValue(commentsEl, payload.cover_letter);
  if (!payload.cover_letter) missingFields.push("cover_letter");

  const customQuestions = document.querySelectorAll<HTMLElement>(
    "li.application-question.custom-question",
  );
  customQuestions.forEach((q) => {
    const label =
      q.querySelector(".application-label")?.textContent?.trim() || "";
    const textarea = q.querySelector<HTMLTextAreaElement>("textarea");
    const input = q.querySelector<HTMLInputElement>('input[type="text"]');
    const target = textarea || input;
    if (target && payload.screening_answers[label]) {
      setReactInputValue(target, payload.screening_answers[label]);
    } else if (label && !payload.screening_answers[label]) {
      missingFields.push(label);
    }
  });

  if (payload.resume_pdf_base64 && payload.resume_filename) {
    const uploadInput =
      document.querySelector<HTMLInputElement>('input[type="file"]');
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
