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

describe("generateScreeningAnswersForJob robustness (US-032)", () => {
  let tempDir: string;
  let getJobById: any;
  let LlmService: any;
  let resolveLlmRuntimeSettings: any;
  let generateScreeningAnswersForJob: any;
  let ScreeningAnswersUnavailableError: any;
  let mockCallJson: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    tempDir = await mkdtemp(
      join(tmpdir(), "job-ops-screening-robustness-test-"),
    );
    process.env.DATA_DIR = tempDir;
    process.env.NODE_ENV = "test";

    await import("../db/migrate");

    ({ getJobById } = await import("../repositories/jobs"));
    ({ LlmService } = await import("./llm/service"));
    ({ resolveLlmRuntimeSettings } = await import("./modelSelection"));

    // Re-import after modules reset
    const ghostwriter = await import("./ghostwriter");
    generateScreeningAnswersForJob = ghostwriter.generateScreeningAnswersForJob;
    ScreeningAnswersUnavailableError =
      ghostwriter.ScreeningAnswersUnavailableError;

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
      jobDescription: "Build things",
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

  it("retries once with a repair prompt when the LLM throws on the first attempt", async () => {
    mockCallJson
      .mockRejectedValueOnce(new Error("LLM unavailable"))
      .mockResolvedValueOnce({
        success: true,
        data: { answers: { "Years of experience?": "5 years" } },
      });

    const result = await generateScreeningAnswersForJob({
      jobId: "job-1",
      profile: {},
      questions: ["Years of experience?"],
    });

    expect(mockCallJson).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ "Years of experience?": "5 years" });
  });

  it("throws ScreeningAnswersUnavailableError when both attempts fail", async () => {
    mockCallJson
      .mockRejectedValueOnce(new Error("LLM unavailable"))
      .mockRejectedValueOnce(new Error("LLM still unavailable"));

    await expect(
      generateScreeningAnswersForJob({
        jobId: "job-1",
        profile: {},
        questions: ["Years of experience?"],
      }),
    ).rejects.toThrow(ScreeningAnswersUnavailableError);
  });

  it("retries when the LLM returns an unsuccessful response (JSON parse error)", async () => {
    mockCallJson
      .mockResolvedValueOnce({ success: false, error: "parse error" })
      .mockResolvedValueOnce({
        success: true,
        data: { answers: { "Years of experience?": "3 years" } },
      });

    const result = await generateScreeningAnswersForJob({
      jobId: "job-1",
      profile: {},
      questions: ["Years of experience?"],
    });

    expect(mockCallJson).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ "Years of experience?": "3 years" });
  });

  it("retries when an answer is missing from the response", async () => {
    mockCallJson
      .mockResolvedValueOnce({
        success: true,
        data: { answers: {} },
      })
      .mockResolvedValueOnce({
        success: true,
        data: { answers: { "Years of experience?": "5 years" } },
      });

    const result = await generateScreeningAnswersForJob({
      jobId: "job-1",
      profile: {},
      questions: ["Years of experience?"],
    });

    expect(mockCallJson).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ "Years of experience?": "5 years" });
  });
});
