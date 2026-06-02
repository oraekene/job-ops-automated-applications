import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./profile", () => ({
  getProfile: vi.fn(),
}));

vi.mock("./scorer", () => ({
  scoreJobSuitability: vi.fn(),
}));

import { getProfile } from "./profile";
import { scoreJobSuitability } from "./scorer";

describe.sequential("applicationService.prepJob suitability scoring (US-004)", () => {
  let tempDir: string;
  let jobsRepo: any;
  let applicationService: any;

  beforeEach(async () => {
    vi.resetModules();
    tempDir = await mkdtemp(join(tmpdir(), "job-ops-prepjob-score-test-"));
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

  it("calls scoreJobSuitability when the job has no precomputed score and a profile is loaded", async () => {
    const url = "https://boards.greenhouse.io/acme/jobs/12345";
    await jobsRepo.createJob({
      source: "greenhouse",
      sourceJobId: "12345",
      title: "Senior Engineer",
      employer: "Acme",
      jobUrl: url,
    });

    vi.mocked(getProfile).mockResolvedValue({
      basics: { name: "Ifeanyi Orae", email: "ifeanyi@example.com" },
    } as any);
    vi.mocked(scoreJobSuitability).mockResolvedValue({
      score: 85,
      reason: "Strong skill match",
    });

    const result = await applicationService.prepJob(url, "greenhouse");

    expect(scoreJobSuitability).toHaveBeenCalledTimes(1);
    expect(result.job?.suitabilityScore).toBe(85);
  });

  it("returns 0 (not NaN, not undefined) when no profile is loaded", async () => {
    const url = "https://boards.greenhouse.io/acme/jobs/12345";
    await jobsRepo.createJob({
      source: "greenhouse",
      sourceJobId: "12345",
      title: "Senior Engineer",
      employer: "Acme",
      jobUrl: url,
    });

    vi.mocked(getProfile).mockRejectedValue(
      new Error("Base resume not configured"),
    );

    const result = await applicationService.prepJob(url, "greenhouse");

    expect(result.job?.suitabilityScore).toBe(0);
    expect(scoreJobSuitability).not.toHaveBeenCalled();
  });

  it("returns the precomputed score from the DB without re-scoring when one is already stored", async () => {
    const url = "https://boards.greenhouse.io/acme/jobs/12345";
    await jobsRepo.createJob({
      source: "greenhouse",
      sourceJobId: "12345",
      title: "Senior Engineer",
      employer: "Acme",
      jobUrl: url,
    });

    const { db, schema } = await import("../db/index");
    const { eq } = await import("drizzle-orm");
    const inserted = await db
      .select()
      .from(schema.jobs)
      .where(eq(schema.jobs.jobUrl, url))
      .get();
    if (!inserted) throw new Error("Expected inserted job row");
    db.update(schema.jobs)
      .set({ suitabilityScore: 0.72 })
      .where(eq(schema.jobs.id, inserted.id))
      .run();

    vi.mocked(getProfile).mockResolvedValue({
      basics: { name: "Ifeanyi Orae", email: "ifeanyi@example.com" },
    } as any);

    const result = await applicationService.prepJob(url, "greenhouse");

    expect(result.job?.suitabilityScore).toBeCloseTo(0.72);
    expect(scoreJobSuitability).not.toHaveBeenCalled();
  });

  it("falls back to 0 (with a warning) when scoreJobSuitability throws", async () => {
    const url = "https://boards.greenhouse.io/acme/jobs/12345";
    await jobsRepo.createJob({
      source: "greenhouse",
      sourceJobId: "12345",
      title: "Senior Engineer",
      employer: "Acme",
      jobUrl: url,
    });

    vi.mocked(getProfile).mockResolvedValue({
      basics: { name: "Ifeanyi Orae", email: "ifeanyi@example.com" },
    } as any);
    vi.mocked(scoreJobSuitability).mockRejectedValue(
      new Error("LLM provider not configured"),
    );

    const result = await applicationService.prepJob(url, "greenhouse");

    expect(result.job?.suitabilityScore).toBe(0);
  });
});
