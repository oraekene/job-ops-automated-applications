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
  },
  ScreeningAnswersValidationError: class ScreeningAnswersValidationError extends Error {
    name = "ScreeningAnswersValidationError" as const;
  },
}));

vi.mock("./pdf", () => ({
  generatePdf: vi.fn(),
  getPdfPath: vi.fn(),
}));

describe.sequential("applicationService.buildPayload fields + cover letter + persist (US-008)", () => {
  let tempDir: string;
  let jobsRepo: any;
  let applicationService: any;
  let applicationRepository: any;
  let getProfile: any;
  let generateScreeningAnswersForJob: any;
  let generateCoverLetterForJob: any;
  let generatePdf: any;
  let getPdfPath: any;

  beforeEach(async () => {
    vi.resetModules();
    tempDir = await mkdtemp(
      join(tmpdir(), "job-ops-buildpayload-fields-test-"),
    );
    process.env.DATA_DIR = tempDir;
    process.env.NODE_ENV = "test";

    await import("../db/migrate");

    jobsRepo = await import("../repositories/jobs");
    applicationService = (await import("./applications")).applicationService;
    applicationRepository = (await import("../repositories/applications"))
      .applicationRepository;

    // Re-import mocks AFTER vi.resetModules so they match the references
    // that applications.ts picks up on its dynamic import.
    ({ getProfile } = await import("./profile"));
    ({ generateScreeningAnswersForJob, generateCoverLetterForJob } =
      await import("./ghostwriter"));
    ({ generatePdf, getPdfPath } = await import("./pdf"));
  });

  afterEach(async () => {
    const { closeDb } = await import("../db/index");
    closeDb();
    await rm(tempDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("populates fields from the profile and a non-empty cover letter, and persists the row with fieldPayload/answers/questions as JSON", async () => {
    const url = "https://boards.greenhouse.io/acme/jobs/12345";
    const job = await jobsRepo.createJob({
      source: "greenhouse",
      sourceJobId: "12345",
      title: "Senior Engineer",
      employer: "Acme",
      jobUrl: url,
    });

    // Write a real PDF file the mocked getPdfPath will return. The real
    // readFile (called by applications.ts) will read this back as bytes
    // for the base64 conversion. This avoids mocking node:fs/promises
    // which is unreliable across vi.resetModules cycles.
    const fakePdfPath = join(tempDir, "fake.pdf");
    const fakePdfBytes = Buffer.from("%PDF-1.4\n%fake\n%%EOF");
    await writeFile(fakePdfPath, fakePdfBytes);

    vi.mocked(getProfile).mockResolvedValue({
      basics: {
        name: "Ifeanyi Orae",
        email: "ifeanyi@example.com",
        phone: "+44 7000 000000",
        profiles: [
          { network: "LinkedIn", url: "https://www.linkedin.com/in/oraekene" },
        ],
      },
      sections: {
        experience: {
          items: [{ company: "Acme Corp", position: "Engineer" }],
        },
      },
    } as any);
    vi.mocked(generateScreeningAnswersForJob).mockResolvedValue({
      "Years of React?": "5 years",
    });
    vi.mocked(generateCoverLetterForJob).mockResolvedValue(
      "I am excited to apply for the Senior Engineer role at Acme.",
    );
    vi.mocked(generatePdf).mockResolvedValue({
      success: true,
      pdfPath: fakePdfPath,
    } as any);
    vi.mocked(getPdfPath).mockReturnValue(fakePdfPath);

    const result = await applicationService.buildPayload(job.id, "greenhouse", [
      "Years of React?",
    ]);

    expect(result.fields).toEqual(
      expect.objectContaining({
        first_name: "Ifeanyi",
        last_name: "Orae",
        email: "ifeanyi@example.com",
        phone: "+447000000000",
        linkedin_url: "https://www.linkedin.com/in/oraekene",
        current_company: "Acme Corp",
      }),
    );
    expect(result.cover_letter.length).toBeGreaterThan(0);
    expect(result.screening_answers).toEqual({ "Years of React?": "5 years" });
    // US-033: result is now a data: URL with gzipped base64 content
    expect(result.resume_pdf_base64).toMatch(/^data:application\/pdf;base64,/);
    expect(result.resume_filename).toBe(`resume_${job.id}.pdf`);

    // Persisted application row
    const persisted = applicationRepository.findByJobId(job.id);
    expect(persisted).not.toBeNull();
    expect(persisted.status).toBe("ready_for_review");
    expect(JSON.parse(persisted.fieldPayload)).toEqual(
      expect.objectContaining({
        first_name: "Ifeanyi",
        last_name: "Orae",
        email: "ifeanyi@example.com",
      }),
    );
    expect(JSON.parse(persisted.screeningAnswers)).toEqual({
      "Years of React?": "5 years",
    });
    expect(JSON.parse(persisted.customQuestions)).toEqual(["Years of React?"]);
  });

  it("throws notFound (404) when the profile is missing so the extension surfaces 'Complete onboarding first'", async () => {
    const url = "https://boards.greenhouse.io/acme/jobs/12345";
    const job = await jobsRepo.createJob({
      source: "greenhouse",
      sourceJobId: "12345",
      title: "Senior Engineer",
      employer: "Acme",
      jobUrl: url,
    });

    vi.mocked(getProfile).mockRejectedValue(
      new Error("Base resume not configured"),
    );

    await expect(
      applicationService.buildPayload(job.id, "greenhouse", []),
    ).rejects.toMatchObject({
      status: 404,
      code: "NOT_FOUND",
    });
  });
});
