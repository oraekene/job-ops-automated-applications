import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./profile", () => ({
  getProfile: vi.fn(),
}));

vi.mock("./ghostwriter", () => ({
  generateScreeningAnswersForJob: vi.fn(),
}));

import { generateScreeningAnswersForJob } from "./ghostwriter";
import { getProfile } from "./profile";

describe.sequential("applicationService.buildPayload screening answers (US-006)", () => {
  let tempDir: string;
  let jobsRepo: any;
  let applicationService: any;

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
