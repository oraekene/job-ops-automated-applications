import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../lib/jobops-api";

const { buildPayloadMock, sendMessageMock } = vi.hoisted(() => ({
  buildPayloadMock: vi.fn(),
  sendMessageMock: vi.fn(),
}));

vi.mock("../lib/jobops-api", () => {
  const ApiError = class extends Error {
    constructor(
      public status: number,
      public code: string,
      message: string,
    ) {
      super(message);
      this.name = "ApiError";
    }
  };
  const NetworkError = class extends Error {
    constructor(message: string) {
      super(message);
      this.name = "NetworkError";
    }
  };
  return {
    JobOpsApi: class {
      baseUrl: string;
      constructor(baseUrl: string) {
        this.baseUrl = baseUrl;
      }
      buildPayload = buildPayloadMock;
    },
    ApiError,
    NetworkError,
  };
});

vi.mock("../drivers/ats-detector", () => ({
  detectAtsByUrl: (url: string) => {
    if (url.includes("greenhouse.io")) return "greenhouse";
    if (url.includes("lever.co")) return "lever";
    return "unknown";
  },
}));

vi.mock("../drivers/greenhouse", () => ({
  fillGreenhouseForm: vi.fn(() => ({ filled: 7 })),
}));
vi.mock("../drivers/lever", () => ({
  fillLeverForm: vi.fn(() => ({ filled: 5 })),
}));

import {
  extractJobIdFromUrl,
  populateAtsForm,
  runDoFill,
} from "../content-script";
import { fillGreenhouseForm } from "../drivers/greenhouse";

function setLocationHref(url: string) {
  Object.defineProperty(window, "location", {
    value: { ...window.location, href: url },
    writable: true,
    configurable: true,
  });
}

function setChromeRuntime() {
  (globalThis as any).chrome = {
    runtime: { sendMessage: sendMessageMock },
  };
}

describe("extractJobIdFromUrl", () => {
  it("reads jobId from the search query", () => {
    expect(
      extractJobIdFromUrl(
        "https://boards.greenhouse.io/acme/jobs/1?jobId=abc-123",
      ),
    ).toBe("abc-123");
  });

  it("reads jobId from the hash when the query is absent", () => {
    expect(
      extractJobIdFromUrl(
        "https://boards.greenhouse.io/acme/jobs/1#jobId=xyz-9",
      ),
    ).toBe("xyz-9");
  });

  it("returns null when neither is present", () => {
    expect(
      extractJobIdFromUrl("https://boards.greenhouse.io/acme/jobs/1"),
    ).toBeNull();
  });
});

describe("runDoFill", () => {
  beforeEach(() => {
    buildPayloadMock.mockReset();
    sendMessageMock.mockReset();
    setChromeRuntime();
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("on 200 calls populateAtsForm and reports success with applicationId", async () => {
    setLocationHref("https://boards.greenhouse.io/acme/jobs/1?jobId=job-200");
    buildPayloadMock.mockResolvedValue({
      applicationId: "app-200",
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
      screening_answers: { "Why us?": "Because engines." },
      resume_pdf_base64: "JVBER",
      resume_filename: "resume_job-200.pdf",
    });

    await runDoFill();

    expect(buildPayloadMock).toHaveBeenCalledWith("job-200", "greenhouse", []);
    expect(sendMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "jobops:result",
        jobId: "job-200",
        outcome: "success",
        applicationId: "app-200",
      }),
    );
  });

  it("on 404 reports skipped with reason 'profile missing' and shows onboarding message", async () => {
    setLocationHref("https://boards.greenhouse.io/acme/jobs/1?jobId=job-404");
    buildPayloadMock.mockRejectedValue(
      new ApiError(404, "NOT_FOUND", "Profile not found"),
    );

    await runDoFill();

    expect(sendMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "jobops:result",
        jobId: "job-404",
        outcome: "skipped",
        reason: "profile missing",
      }),
    );
    const shadowHost = document.getElementById("jobops-panel");
    expect(shadowHost).not.toBeNull();
  });

  it("on 422 reports skipped with the server's reason", async () => {
    setLocationHref("https://boards.greenhouse.io/acme/jobs/1?jobId=job-422");
    buildPayloadMock.mockRejectedValue(
      new ApiError(422, "UNPROCESSABLE_ENTITY", "PDF generation failed"),
    );

    await runDoFill();

    expect(sendMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "jobops:result",
        jobId: "job-422",
        outcome: "skipped",
        reason: "PDF generation failed",
      }),
    );
  });
});

describe("populateAtsForm", () => {
  it("calls the greenhouse driver with merged fields, cover_letter and screening_answers", () => {
    const payload = {
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
      screening_answers: { "Why us?": "Because engines." },
      resume_pdf_base64: "JVBER",
      resume_filename: "resume.pdf",
    };

    populateAtsForm(payload, "greenhouse");

    expect(fillGreenhouseForm).toHaveBeenCalledWith(
      expect.objectContaining({
        first_name: "Ada",
        cover_letter: "Dear Hiring Manager...",
        screening_answers: { "Why us?": "Because engines." },
      }),
    );
  });
});
