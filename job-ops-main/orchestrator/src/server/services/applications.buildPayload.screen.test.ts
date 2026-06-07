import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./profile", () => ({
  getProfile: vi.fn(),
}));

vi.mock("./ghostwriter", () => ({
  generateScreeningAnswersForJob: vi.fn(),
  generateCoverLetterForJob: vi.fn(),
  ScreeningAnswersUnavailableError: class ScreeningAnswersUnavailableError extends Error {
    name = "ScreeningAnswersUnavailableError" as const;
    constructor(message: string) {
      super(message);
    }
  },
  ScreeningAnswersValidationError: class ScreeningAnswersValidationError extends Error {
    name = "ScreeningAnswersValidationError" as const;
    constructor(message: string) {
      super(message);
    }
  },
  CoverLetterValidationError: class CoverLetterValidationError extends Error {
    name = "CoverLetterValidationError" as const;
    reason: string;
    constructor(message: string, reason: string) {
      super(message);
      this.reason = reason;
    }
  },
}));

vi.mock("./pdf", () => ({
  generatePdf: vi.fn(),
  getPdfPath: vi.fn(),
}));

describe.sequential("applicationService.buildPayload screening answers (US-006)", () => {
  let tempDir: string;
  let jobsRepo: any;
  let applicationService: any;
  let getProfile: any;
  let generateScreeningAnswersForJob: any;
  let generateCoverLetterForJob: any;
  let generatePdf: any;
  let getPdfPath: any;

  beforeEach(async () => {
    vi.resetModules();
    tempDir = await mkdtemp(
      join(tmpdir(), "job-ops-buildpayload-screen-test-"),
    );
    process.env.DATA_DIR = tempDir;
    process.env.NODE_ENV = "test";

    await import("../db/migrate");

    jobsRepo = await import("../repositories/jobs");
    applicationService = (await import("./applications")).applicationService;

    // Re-import mocks AFTER vi.resetModules so they match the references
    // that applications.ts picks up on its dynamic import.
    ({ getProfile } = await import("./profile"));
    ({ generateScreeningAnswersForJob, generateCoverLetterForJob } =
      await import("./ghostwriter"));
    ({ generatePdf, getPdfPath } = await import("./pdf"));

    // Write a real PDF file the mocked getPdfPath will return.
    const pdfPath = join(tempDir, "fake.pdf");
    const fakePdf = Buffer.from(`%PDF-1.4\n${"x".repeat(1500)}\n%%EOF`);
    await writeFile(pdfPath, fakePdf);
    vi.mocked(generatePdf).mockResolvedValue({
      success: true,
      pdfPath,
    } as any);
    vi.mocked(getPdfPath).mockReturnValue(pdfPath);
  });

  afterEach(async () => {
    const { closeDb } = await import("../db/index");
    closeDb();
    await rm(tempDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("returns a question→answer map for a non-empty customQuestions array", async () => {
    const url = "https://boards.greenhouse.io/acme/jobs/12345";
    const job = await jobsRepo.createJob({
      source: "greenhouse",
      sourceJobId: "12345",
      title: "Senior Engineer",
      employer: "Acme",
      jobUrl: url,
    });

    vi.mocked(getProfile).mockResolvedValue({
      basics: { name: "Ifeanyi Orae", email: "ifeanyi@example.com" },
    } as any);
    vi.mocked(generateScreeningAnswersForJob).mockResolvedValue({
      "Years of React experience?": "5 years building production SPAs.",
    });

    const result = await applicationService.buildPayload(job.id, "greenhouse", [
      "Years of React experience?",
    ]);

    expect(result.screening_answers).toEqual({
      "Years of React experience?": "5 years building production SPAs.",
    });
    expect(generateScreeningAnswersForJob).toHaveBeenCalledTimes(1);
  });

  it("returns an empty map for an empty customQuestions array (no LLM call)", async () => {
    const url = "https://boards.greenhouse.io/acme/jobs/12345";
    const job = await jobsRepo.createJob({
      source: "greenhouse",
      sourceJobId: "12345",
      title: "Senior Engineer",
      employer: "Acme",
      jobUrl: url,
    });

    vi.mocked(getProfile).mockResolvedValue({
      basics: { name: "Ifeanyi Orae", email: "ifeanyi@example.com" },
    } as any);

    const result = await applicationService.buildPayload(
      job.id,
      "greenhouse",
      [],
    );

    expect(result.screening_answers).toEqual({});
    expect(generateScreeningAnswersForJob).not.toHaveBeenCalled();
  });
});
