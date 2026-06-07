import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../repositories/jobs", () => ({
  getJobById: vi.fn(),
}));

vi.mock("./llm/service", () => ({
  LlmService: vi.fn(),
}));

vi.mock("./modelSelection", () => ({
  resolveLlmRuntimeSettings: vi.fn(),
}));

describe("generateCoverLetterForJob quality (US-034)", () => {
  let tempDir: string;
  let getJobById: any;
  let LlmService: any;
  let resolveLlmRuntimeSettings: any;
  let generateCoverLetterForJob: any;
  let CoverLetterValidationError: any;
  let mockCallJson: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    tempDir = await mkdtemp(
      join(tmpdir(), "job-ops-coverletter-quality-test-"),
    );
    process.env.DATA_DIR = tempDir;
    process.env.NODE_ENV = "test";

    await import("../db/migrate");

    ({ getJobById } = await import("../repositories/jobs"));
    ({ LlmService } = await import("./llm/service"));
    ({ resolveLlmRuntimeSettings } = await import("./modelSelection"));

    const ghostwriter = await import("./ghostwriter");
    generateCoverLetterForJob = ghostwriter.generateCoverLetterForJob;
    CoverLetterValidationError = ghostwriter.CoverLetterValidationError;

    mockCallJson = vi.fn();
    (LlmService as any).mockImplementation(function (this: any) {
      this.callJson = mockCallJson;
    });

    vi.mocked(resolveLlmRuntimeSettings).mockResolvedValue({
      model: "test-model",
      provider: "test",
      baseUrl: null,
      apiKey: null,
    });

    const url = "https://boards.greenhouse.io/acme/jobs/12345";
    vi.mocked(getJobById).mockResolvedValue({
      id: "job-1",
      title: "Senior Engineer",
      employer: "Acme",
      jobDescription: "Build things in React",
      source: "greenhouse",
      sourceJobId: "12345",
      jobUrl: url,
      pdfRegenerating: false,
      pdfGeneratedAt: null,
      pdfFingerprint: null,
    });
  });

  afterEach(async () => {
    const { closeDb } = await import("../db/index");
    closeDb();
    await rm(tempDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("returns a structured cover letter with 3 paragraphs (intro/body/outro/fullText)", async () => {
    const intro =
      "Dear Hiring Team, I am excited to apply for the Senior Engineer role at Acme.";
    const body =
      "In my previous role I led the React migration, improved build times by 40%, and mentored two junior engineers across two years of dedicated frontend work.";
    const outro =
      "I would love to discuss how my experience fits Acme's roadmap. Thank you for your consideration.";

    mockCallJson.mockResolvedValueOnce({
      success: true,
      data: {
        intro,
        body,
        outro,
        fullText: `${intro}\n\n${body}\n\n${outro}`,
      },
    });

    const result = await generateCoverLetterForJob({
      jobId: "job-1",
      profile: { full_name: "Ifeanyi Orae" },
    });

    expect(result).toContain("Dear Hiring Team");
    expect(result).toContain("React migration");
    expect(result).toContain("Thank you for your consideration");
    expect(mockCallJson).toHaveBeenCalledTimes(1);
  });

  it("retries once with a length-correcting prompt when the first response is too short", async () => {
    const short = "I want this job.";
    const retry =
      "I am a Senior Engineer with 5 years of React experience and a track record of shipping fast, accessible UI. At my last role I led the migration of a monolithic frontend to a typed React stack, cutting time-to-interactive by 40% and cutting on-call pages by half. I would love to bring that same craft and care to Acme's frontend team.";

    mockCallJson
      .mockResolvedValueOnce({
        success: true,
        data: { intro: short, body: "", outro: "", fullText: short },
      })
      .mockResolvedValueOnce({
        success: true,
        data: {
          intro: retry.slice(0, 100),
          body: retry.slice(100, 400),
          outro: retry.slice(400),
          fullText: retry,
        },
      });

    const result = await generateCoverLetterForJob({
      jobId: "job-1",
      profile: {},
    });

    expect(result.length).toBeGreaterThanOrEqual(100);
    expect(mockCallJson).toHaveBeenCalledTimes(2);
    const repairSystemPrompt =
      mockCallJson.mock.calls[1][0].messages[0].content;
    expect(repairSystemPrompt).toMatch(/too short/i);
  });

  it("retries once with a contradiction-fix prompt when the cover letter contradicts the screening answers on duration", async () => {
    const screeningAnswers = { "Years of React?": "5 years" };
    const contradicting =
      "I bring 3 years of React experience and a strong product sense. In my three years I led the migration of a monolith to a typed React stack.";
    const corrected =
      "I bring 5 years of React experience and a strong product sense. Across my 5 years I have led the migration of a monolith to a typed React stack, shipped a design system used by 12 product teams, and mentored 4 engineers. I would love to bring that craft to Acme.";

    mockCallJson
      .mockResolvedValueOnce({
        success: true,
        data: {
          intro: contradicting.slice(0, 80),
          body: contradicting.slice(80),
          outro: "Thanks.",
          fullText: contradicting,
        },
      })
      .mockResolvedValueOnce({
        success: true,
        data: {
          intro: corrected.slice(0, 100),
          body: corrected.slice(100, 400),
          outro: corrected.slice(400),
          fullText: corrected,
        },
      });

    const result = await generateCoverLetterForJob({
      jobId: "job-1",
      profile: {},
      screeningAnswers,
    });

    expect(result).toContain("5 years");
    expect(result).not.toMatch(/\b3 years\b/);
    expect(mockCallJson).toHaveBeenCalledTimes(2);
    const repairSystemPrompt =
      mockCallJson.mock.calls[1][0].messages[0].content;
    expect(repairSystemPrompt).toMatch(/contradict/i);
  });

  it("throws CoverLetterValidationError when the LLM response is still too short after retry", async () => {
    const short = "Hi.";

    mockCallJson
      .mockResolvedValueOnce({
        success: true,
        data: { intro: short, body: "", outro: "", fullText: short },
      })
      .mockResolvedValueOnce({
        success: true,
        data: { intro: "Hi", body: "", outro: "Hi", fullText: "Hi" },
      });

    await expect(
      generateCoverLetterForJob({
        jobId: "job-1",
        profile: {},
      }),
    ).rejects.toBeInstanceOf(CoverLetterValidationError);
  });

  it("emits cover letter chunks via onChunk callback as the final text is built", async () => {
    const fullText =
      "Dear Hiring Team, I am excited to apply for the Senior Engineer role at Acme. I bring 5 years of React experience and a track record of shipping fast, accessible UI. At my last role I led the migration of a monolithic frontend to a typed React stack, cutting time-to-interactive by 40% and cutting on-call pages by half. I would love to bring that same craft and care to Acme's frontend team. Thank you for your consideration.";

    mockCallJson.mockResolvedValueOnce({
      success: true,
      data: {
        intro: fullText.slice(0, 100),
        body: fullText.slice(100, 400),
        outro: fullText.slice(400),
        fullText,
      },
    });

    const chunks: string[] = [];
    await generateCoverLetterForJob({
      jobId: "job-1",
      profile: {},
      onChunk: (chunk: string) => chunks.push(chunk),
    });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(fullText);
  });
});
