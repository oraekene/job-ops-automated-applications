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
  CoverLetterValidationError: class CoverLetterValidationError extends Error {
    name = "CoverLetterValidationError" as const;
    reason = "invalid" as const;
  },
}));

vi.mock("./pdf", () => ({
  generatePdf: vi.fn(),
  getPdfPath: vi.fn(),
}));

vi.mock("./settings", () => ({
  getEffectiveSettings: vi.fn(),
}));

vi.mock("./suitability", () => ({
  recomputeAndPersistSuitabilityScore: vi.fn(),
}));

import { generateScreeningAnswersForJob } from "./ghostwriter";
import { generatePdf, getPdfPath } from "./pdf";
import { getProfile } from "./profile";
import { getEffectiveSettings } from "./settings";

describe.sequential("applicationService.buildPayload PDF integrity (US-033)", () => {
  let tempDir: string;
  let jobsRepo: any;
  let applicationService: any;

  beforeEach(async () => {
    vi.resetModules();
    tempDir = await mkdtemp(
      join(tmpdir(), "job-ops-buildpayload-pdfintegrity-test-"),
    );
    process.env.DATA_DIR = tempDir;
    process.env.NODE_ENV = "test";

    await import("../db/migrate");

    jobsRepo = await import("../repositories/jobs");
    applicationService = (await import("./applications")).applicationService;

    vi.mocked(getProfile).mockResolvedValue({
      basics: { name: "Test User", email: "test@example.com" },
    } as any);
    vi.mocked(generateScreeningAnswersForJob).mockResolvedValue({});
    vi.mocked(getEffectiveSettings).mockResolvedValue({
      autoApplicationDefaultCoverLetter: {
        value: "Default cover letter",
        default: "",
        override: null,
      },
    } as any);
  });

  afterEach(async () => {
    const { closeDb } = await import("../db/index");
    closeDb();
    await rm(tempDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("returns a valid base64-encoded PDF when file starts with %PDF-", async () => {
    const url = "https://boards.greenhouse.io/acme/jobs/601";
    const job = await jobsRepo.createJob({
      source: "greenhouse",
      sourceJobId: "601",
      title: "Engineer",
      employer: "Acme",
      jobUrl: url,
    });

    const pdfPath = join(tempDir, "resume.pdf");
    const fakePdf = Buffer.from("%PDF-1.4\n%content\n%%EOF");
    await writeFile(pdfPath, fakePdf);

    vi.mocked(generatePdf).mockResolvedValue({ success: true, pdfPath } as any);
    vi.mocked(getPdfPath).mockReturnValue(pdfPath);

    const result = await applicationService.buildPayload(
      job.id,
      "greenhouse",
      [],
    );

    expect(result.resume_pdf_base64).toBeDefined();
    expect(typeof result.resume_pdf_base64).toBe("string");
    expect(result.resume_pdf_base64.length).toBeGreaterThan(0);
  });

  it("throws 422 when PDF has corrupted header (not %PDF-)", async () => {
    const url = "https://boards.greenhouse.io/acme/jobs/602";
    const job = await jobsRepo.createJob({
      source: "greenhouse",
      sourceJobId: "602",
      title: "Engineer",
      employer: "Acme",
      jobUrl: url,
    });

    const pdfPath = join(tempDir, "bad.pdf");
    const fakePdf = Buffer.from("NOTAVALIDPDF\ncontent");
    await writeFile(pdfPath, fakePdf);

    vi.mocked(generatePdf).mockResolvedValue({ success: true, pdfPath } as any);
    vi.mocked(getPdfPath).mockReturnValue(pdfPath);

    await expect(
      applicationService.buildPayload(job.id, "greenhouse", []),
    ).rejects.toMatchObject({
      status: 422,
      code: "UNPROCESSABLE_ENTITY",
    });
  });

  it("throws 422 when PDF file exceeds 10MB limit", async () => {
    const url = "https://boards.greenhouse.io/acme/jobs/603";
    const job = await jobsRepo.createJob({
      source: "greenhouse",
      sourceJobId: "603",
      title: "Engineer",
      employer: "Acme",
      jobUrl: url,
    });

    const pdfPath = join(tempDir, "big.pdf");
    const pdfHeader = "%PDF-1.4\n";
    const pdfBody = "x".repeat(11 * 1024 * 1024); // 11 MB > 10 MB
    const fakePdf = Buffer.from(`${pdfHeader}${pdfBody}\n%%EOF`);
    await writeFile(pdfPath, fakePdf);

    vi.mocked(generatePdf).mockResolvedValue({ success: true, pdfPath } as any);
    vi.mocked(getPdfPath).mockReturnValue(pdfPath);

    await expect(
      applicationService.buildPayload(job.id, "greenhouse", []),
    ).rejects.toMatchObject({
      status: 413,
    });
  });

  it("returns data:application/pdf;base64,... URL format for valid PDF", async () => {
    const url = "https://boards.greenhouse.io/acme/jobs/604";
    const job = await jobsRepo.createJob({
      source: "greenhouse",
      sourceJobId: "604",
      title: "Engineer",
      employer: "Acme",
      jobUrl: url,
    });

    const pdfPath = join(tempDir, "resume.pdf");
    const fakePdf = Buffer.from("%PDF-1.4\n%content\n%%EOF");
    await writeFile(pdfPath, fakePdf);

    vi.mocked(generatePdf).mockResolvedValue({ success: true, pdfPath } as any);
    vi.mocked(getPdfPath).mockReturnValue(pdfPath);

    const result = await applicationService.buildPayload(
      job.id,
      "greenhouse",
      [],
    );

    expect(result.resume_pdf_base64).toMatch(/^data:application\/pdf;base64,/);
  });
});
