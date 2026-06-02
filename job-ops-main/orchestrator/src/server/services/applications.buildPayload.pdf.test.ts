import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./profile", () => ({
  getProfile: vi.fn(),
}));

vi.mock("./ghostwriter", () => ({
  generateScreeningAnswersForJob: vi.fn(),
}));

vi.mock("./pdf", () => ({
  generatePdf: vi.fn(),
  getPdfPath: vi.fn(),
}));

import { generateScreeningAnswersForJob } from "./ghostwriter";
import { generatePdf, getPdfPath } from "./pdf";
import { getProfile } from "./profile";

describe.sequential("applicationService.buildPayload PDF generation (US-007)", () => {
  let tempDir: string;
  let jobsRepo: any;
  let applicationService: any;

  beforeEach(async () => {
    vi.resetModules();
    tempDir = await mkdtemp(join(tmpdir(), "job-ops-buildpayload-pdf-test-"));
    process.env.DATA_DIR = tempDir;
    process.env.NODE_ENV = "test";

    await import("../db/migrate");

    jobsRepo = await import("../repositories/jobs");
    applicationService = (await import("./applications")).applicationService;
  });

  afterEach(async () => {
    const { closeDb } = await import("../db/index");
    closeDb();
    await rm(tempDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("returns a base64-encoded PDF and a resume_<jobId>.pdf filename on success", async () => {
    const url = "https://boards.greenhouse.io/acme/jobs/12345";
    const job = await jobsRepo.createJob({
      source: "greenhouse",
      sourceJobId: "12345",
      title: "Senior Engineer",
      employer: "Acme",
      jobUrl: url,
    });

    // Write a fake PDF file at a known path under tempDir
    const pdfPath = join(tempDir, "resume.pdf");
    const fakePdf = Buffer.from("%PDF-1.4\n%fake pdf body for testing\n%%EOF");
    await writeFile(pdfPath, fakePdf);

    vi.mocked(getProfile).mockResolvedValue({
      basics: { name: "Ifeanyi Orae", email: "ifeanyi@example.com" },
    } as any);
    vi.mocked(generateScreeningAnswersForJob).mockResolvedValue({});
    vi.mocked(generatePdf).mockResolvedValue({
      success: true,
      pdfPath,
    } as any);
    vi.mocked(getPdfPath).mockReturnValue(pdfPath);

    const result = await applicationService.buildPayload(
      job.id,
      "greenhouse",
      [],
    );

    expect(result.resume_pdf_base64.length).toBeGreaterThan(1000);
    expect(result.resume_filename).toBe(`resume_${job.id}.pdf`);
    // The encoded content should be decodable back to the original
    const decoded = Buffer.from(result.resume_pdf_base64, "base64");
    expect(decoded.equals(fakePdf)).toBe(true);
  });

  it("throws an unprocessableEntity error when PDF generation fails", async () => {
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
    vi.mocked(generateScreeningAnswersForJob).mockResolvedValue({});
    vi.mocked(generatePdf).mockResolvedValue({
      success: false,
      error: "Renderer exploded",
      errorCode: "UNPROCESSABLE_ENTITY",
    } as any);

    await expect(
      applicationService.buildPayload(job.id, "greenhouse", []),
    ).rejects.toMatchObject({
      status: 422,
      code: "UNPROCESSABLE_ENTITY",
    });
  });
});
