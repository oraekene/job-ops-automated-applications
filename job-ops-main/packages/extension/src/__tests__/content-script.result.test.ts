import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

const { uploadFlags } = vi.hoisted(() => ({
  uploadFlags: { dataTransferPresent: true },
}));
vi.mock("../drivers/shared/file-injector", () => ({
  uploadResume: vi.fn(
    (input: HTMLInputElement | null) =>
      uploadFlags.dataTransferPresent && input !== null,
  ),
}));

import { reportResult, runDoFill } from "../content-script";

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

describe("reportResult (US-016a)", () => {
  beforeEach(() => {
    sendMessageMock.mockReset();
    setChromeRuntime();
  });

  it("posts a result with outcome 'submitted' on successful fill", async () => {
    buildPayloadMock.mockReset();
    setLocationHref(
      "https://boards.greenhouse.io/acme/jobs/1?jobId=job-sub",
    );
    uploadFlags.dataTransferPresent = true;
    document.body.innerHTML =
      '<input type="file" data-qa="resume-upload-input" />';
    buildPayloadMock.mockResolvedValue({
      applicationId: "app-sub",
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
      resume_filename: "resume_job-sub.pdf",
    });

    await runDoFill();

    expect(sendMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "jobops:result",
        jobId: "job-sub",
        outcome: "submitted",
        fieldSnapshot: expect.objectContaining({
          first_name: "Ada",
        }),
        answersSnapshot: expect.objectContaining({
          "Why us?": "Because engines.",
        }),
      }),
    );
  });

  it("posts a result with outcome 'skipped' and reason when resume upload is missing", async () => {
    buildPayloadMock.mockReset();
    setLocationHref(
      "https://jobs.lever.co/globex/abc-1?jobId=job-skip",
    );
    uploadFlags.dataTransferPresent = true;
    document.body.innerHTML = "";
    buildPayloadMock.mockResolvedValue({
      applicationId: "app-skip",
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
      screening_answers: {},
      resume_pdf_base64: "JVBER",
      resume_filename: "resume_lever.pdf",
    });

    await runDoFill();

    expect(sendMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "jobops:result",
        jobId: "job-skip",
        outcome: "skipped",
        reason: "no resume upload input",
      }),
    );
  });

  it("posts a result with outcome 'failed' when an uncaught throw occurs", async () => {
    buildPayloadMock.mockReset();
    setLocationHref(
      "https://boards.greenhouse.io/acme/jobs/1?jobId=job-fail",
    );
    buildPayloadMock.mockRejectedValue(new Error("network boom"));

    await runDoFill();

    expect(sendMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "jobops:result",
        jobId: "job-fail",
        outcome: "failed",
        reason: "unexpected error",
        error: expect.objectContaining({
          message: "network boom",
        }),
      }),
    );
  });
});

describe("extractConfirmationId (US-016a)", () => {
  it("extracts gh_jid from query params", async () => {
    const { extractConfirmationId } = await import("../content-script");
    setLocationHref(
      "https://boards.greenhouse.io/acme/apply?gh_jid=abc-123",
    );
    expect(extractConfirmationId()).toBe("abc-123");
  });

  it("extracts confirmation id from pathname", async () => {
    const { extractConfirmationId } = await import("../content-script");
    setLocationHref(
      "https://boards.greenhouse.io/acme/confirmation/xyz-789",
    );
    expect(extractConfirmationId()).toBe("xyz-789");
  });

  it("returns null when no confirmation id is present", async () => {
    const { extractConfirmationId } = await import("../content-script");
    setLocationHref("https://boards.greenhouse.io/acme/jobs/1");
    expect(extractConfirmationId()).toBeNull();
  });
});
