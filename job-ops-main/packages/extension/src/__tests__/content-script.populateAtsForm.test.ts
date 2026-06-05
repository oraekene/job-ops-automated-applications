import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/jobops-api", () => ({
  JobOpsApi: class {
    baseUrl: string;
    constructor(baseUrl: string) {
      this.baseUrl = baseUrl;
    }
  },
  ApiError: class extends Error {
    constructor(
      public status: number,
      public code: string,
      message: string,
    ) {
      super(message);
      this.name = "ApiError";
    }
  },
  NetworkError: class extends Error {
    constructor(message: string) {
      super(message);
      this.name = "NetworkError";
    }
  },
}));

import { populateAtsForm } from "../content-script";

function greenhouseFullDom(): void {
  document.body.innerHTML = `
    <div data-qa="first-name-field"><input /></div>
    <div data-qa="last-name-field"><input /></div>
    <div data-qa="email-field"><input /></div>
    <div data-qa="phone-field"><input /></div>
    <div data-qa="linkedin-field"><input /></div>
    <div data-qa="org-field"><input /></div>
    <textarea data-qa="cover-letter-text-input"></textarea>
  `;
}

function leverFullDom(): void {
  document.body.innerHTML = `
    <input name="name" />
    <input name="email" />
    <input name="phone" />
    <input name="org" />
    <input name="urls[LinkedIn]" />
    <textarea name="comments"></textarea>
  `;
}

const fullPayload = {
  applicationId: "app-1",
  fields: {
    first_name: "Ada",
    last_name: "Lovelace",
    email: "ada@example.com",
    phone: "+44 7000 000000",
    linkedin_url: "https://www.linkedin.com/in/ada",
    current_company: "Engines Ltd",
    salary: "100000",
  },
  cover_letter: "Dear Hiring Manager...",
  screening_answers: {} as Record<string, string>,
  resume_pdf_base64: "",
  resume_filename: "",
};

describe("populateAtsForm - Greenhouse full DOM", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("fills the 7 standard inputs and the cover letter textarea", () => {
    greenhouseFullDom();

    populateAtsForm(fullPayload, "greenhouse");

    const get = <T extends HTMLElement>(sel: string) =>
      document.querySelector<T>(sel) as T;
    expect(
      get<HTMLInputElement>('[data-qa="first-name-field"] input').value,
    ).toBe("Ada");
    expect(
      get<HTMLInputElement>('[data-qa="last-name-field"] input').value,
    ).toBe("Lovelace");
    expect(get<HTMLInputElement>('[data-qa="email-field"] input').value).toBe(
      "ada@example.com",
    );
    expect(get<HTMLInputElement>('[data-qa="phone-field"] input').value).toBe(
      "+44 7000 000000",
    );
    expect(
      get<HTMLInputElement>('[data-qa="linkedin-field"] input').value,
    ).toBe("https://www.linkedin.com/in/ada");
    expect(get<HTMLInputElement>('[data-qa="org-field"] input').value).toBe(
      "Engines Ltd",
    );
    expect(
      get<HTMLTextAreaElement>('[data-qa="cover-letter-text-input"]').value,
    ).toBe("Dear Hiring Manager...");
  });
});

describe("populateAtsForm - Lever full DOM", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("fills the 5 standard inputs (name split into first+last) and the comments textarea", () => {
    leverFullDom();

    populateAtsForm(fullPayload, "lever");

    expect(
      (
        document.querySelector<HTMLInputElement>(
          'input[name="name"]',
        ) as HTMLInputElement
      ).value,
    ).toBe("Ada Lovelace");
    expect(
      (
        document.querySelector<HTMLInputElement>(
          'input[name="email"]',
        ) as HTMLInputElement
      ).value,
    ).toBe("ada@example.com");
    expect(
      (
        document.querySelector<HTMLInputElement>(
          'input[name="phone"]',
        ) as HTMLInputElement
      ).value,
    ).toBe("+44 7000 000000");
    expect(
      (
        document.querySelector<HTMLInputElement>(
          'input[name="org"]',
        ) as HTMLInputElement
      ).value,
    ).toBe("Engines Ltd");
    expect(
      (
        document.querySelector<HTMLInputElement>(
          'input[name="urls[LinkedIn]"]',
        ) as HTMLInputElement
      ).value,
    ).toBe("https://www.linkedin.com/in/ada");
    expect(
      (
        document.querySelector<HTMLTextAreaElement>(
          'textarea[name="comments"]',
        ) as HTMLTextAreaElement
      ).value,
    ).toBe("Dear Hiring Manager...");
  });
});

describe("populateAtsForm - Greenhouse custom question", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("fills a custom question textarea when the question text matches a screening_answers key", () => {
    greenhouseFullDom();
    const customQuestionContainer = document.createElement("div");
    customQuestionContainer.setAttribute("data-qa", "question_12345");
    customQuestionContainer.innerHTML = `
      <label>Why do you want to work here?</label>
      <textarea></textarea>
    `;
    document.body.appendChild(customQuestionContainer);

    populateAtsForm(
      {
        ...fullPayload,
        screening_answers: {
          "Why do you want to work here?": "Because engines.",
        },
      },
      "greenhouse",
    );

    const textarea = customQuestionContainer.querySelector(
      "textarea",
    ) as HTMLTextAreaElement;
    expect(textarea.value).toBe("Because engines.");
  });
});

describe("populateAtsForm - Greenhouse no custom questions (negative)", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("completes without errors and leaves payload.screening_answers untouched when no questions exist in DOM", () => {
    greenhouseFullDom();

    const screeningAnswers = { "Unrelated question": "Unused answer" };
    const original = { ...screeningAnswers };

    expect(() => {
      populateAtsForm(
        { ...fullPayload, screening_answers: screeningAnswers },
        "greenhouse",
      );
    }).not.toThrow();

    expect(screeningAnswers).toEqual(original);
  });
});
