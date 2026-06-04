import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applicationService } from "./applications";
import { onProfileChange } from "./profile";
import { scoreJobSuitability } from "./scorer";

vi.mock("./scorer", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./scorer")>();
  return {
    ...mod,
    scoreJobSuitability: vi.fn(),
  };
});

vi.mock("./settings", () => ({
  getEffectiveSettings: vi.fn(),
}));

vi.mock("./profile", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./profile")>();
  return {
    ...mod,
    getProfile: vi.fn(),
  };
});

async function insertJob(
  jobsRepo: any,
  db: any,
  schema: any,
  opts: {
    title: string;
    employer: string;
    jobUrl: string;
    suitabilityScore?: number;
    suitabilityComputedAt?: string | null;
  },
): Promise<string> {
  const job = await jobsRepo.createJob({
    source: "greenhouse",
    title: opts.title,
    employer: opts.employer,
    jobUrl: opts.jobUrl,
  });
  if (
    opts.suitabilityScore != null ||
    opts.suitabilityComputedAt !== undefined
  ) {
    db.update(schema.jobs)
      .set({
        suitabilityScore: opts.suitabilityScore ?? null,
        suitabilityComputedAt: opts.suitabilityComputedAt ?? null,
      })
      .where(eq(schema.jobs.id, job.id))
      .run();
  }
  return job.id;
}

describe.sequential("suitability staleness (US-030)", () => {
  let tempDir: string;
  let jobsRepo: any;
  let db: any;
  let schema: any;
  let { getProfile }: { getProfile: any } = { getProfile: vi.fn() };

  beforeEach(async () => {
    vi.resetModules();
    tempDir = await mkdtemp(join(tmpdir(), "job-ops-stale-test-"));
    process.env.DATA_DIR = tempDir;
    process.env.NODE_ENV = "test";

    await import("../db/migrate");

    jobsRepo = await import("../repositories/jobs");
    const dbModule = await import("../db/index");
    db = dbModule.db;
    schema = dbModule.schema;

    ({ getProfile } = await import("./profile"));
  });

  afterEach(async () => {
    const { closeDb } = await import("../db/index");
    closeDb();
    await rm(tempDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("recomputes when suitabilityComputedAt is older than 7 days and a profile is loaded", async () => {
    const eightDaysAgo = new Date(
      Date.now() - 8 * 24 * 60 * 60 * 1000,
    ).toISOString();
    const id = await insertJob(jobsRepo, db, schema, {
      title: "Senior Engineer",
      employer: "Acme",
      jobUrl: "https://boards.greenhouse.io/acme/jobs/1",
      suitabilityScore: 50,
      suitabilityComputedAt: eightDaysAgo,
    });
    vi.mocked(getProfile).mockResolvedValue({
      basics: { name: "Ada", email: "ada@example.com" },
    });
    vi.mocked(scoreJobSuitability).mockResolvedValue({
      score: 88,
      reason: "Recomputed fresh match",
    });

    const result = await applicationService.prepJob(
      "https://boards.greenhouse.io/acme/jobs/1",
      "greenhouse",
    );

    expect(scoreJobSuitability).toHaveBeenCalledTimes(1);
    expect(result.job?.suitabilityScore).toBe(88);
    expect(result.suitabilityStale).toBe(true);

    const stored = db
      .select()
      .from(schema.jobs)
      .where(eq(schema.jobs.id, id))
      .get();
    expect(stored?.suitabilityScore).toBe(88);
    expect(stored?.suitabilityComputedAt).not.toBe(eightDaysAgo);
  });

  it("does not recompute when suitabilityComputedAt is fresh (1 day old)", async () => {
    const oneDayAgo = new Date(
      Date.now() - 1 * 24 * 60 * 60 * 1000,
    ).toISOString();
    await insertJob(jobsRepo, db, schema, {
      title: "Engineer",
      employer: "Globex",
      jobUrl: "https://boards.greenhouse.io/globex/jobs/1",
      suitabilityScore: 72,
      suitabilityComputedAt: oneDayAgo,
    });
    vi.mocked(getProfile).mockResolvedValue({
      basics: { name: "Ada", email: "ada@example.com" },
    });

    const result = await applicationService.prepJob(
      "https://boards.greenhouse.io/globex/jobs/1",
      "greenhouse",
    );

    expect(scoreJobSuitability).not.toHaveBeenCalled();
    expect(result.job?.suitabilityScore).toBe(72);
    expect(result.suitabilityStale).toBe(false);
  });

  it("uses the stored score (no recompute) when profile is null even if the stored score is stale", async () => {
    const eightDaysAgo = new Date(
      Date.now() - 8 * 24 * 60 * 60 * 1000,
    ).toISOString();
    await insertJob(jobsRepo, db, schema, {
      title: "Engineer",
      employer: "Hooli",
      jobUrl: "https://boards.greenhouse.io/hooli/jobs/1",
      suitabilityScore: 33,
      suitabilityComputedAt: eightDaysAgo,
    });
    vi.mocked(getProfile).mockRejectedValue(new Error("onboarding incomplete"));

    const result = await applicationService.prepJob(
      "https://boards.greenhouse.io/hooli/jobs/1",
      "greenhouse",
    );

    expect(scoreJobSuitability).not.toHaveBeenCalled();
    expect(result.job?.suitabilityScore).toBe(33);
    expect(result.suitabilityStale).toBe(false);
  });

  it("onProfileChange() resets suitabilityComputedAt to NULL for all tenant jobs", async () => {
    const eightDaysAgo = new Date(
      Date.now() - 8 * 24 * 60 * 60 * 1000,
    ).toISOString();
    const id1 = await insertJob(jobsRepo, db, schema, {
      title: "Job 1",
      employer: "Acme",
      jobUrl: "https://boards.greenhouse.io/acme/jobs/1",
      suitabilityScore: 50,
      suitabilityComputedAt: eightDaysAgo,
    });
    const id2 = await insertJob(jobsRepo, db, schema, {
      title: "Job 2",
      employer: "Acme",
      jobUrl: "https://boards.greenhouse.io/acme/jobs/2",
      suitabilityScore: 60,
      suitabilityComputedAt: eightDaysAgo,
    });

    const reset = onProfileChange();
    expect(reset).toBe(2);

    const after1 = db
      .select()
      .from(schema.jobs)
      .where(eq(schema.jobs.id, id1))
      .get();
    const after2 = db
      .select()
      .from(schema.jobs)
      .where(eq(schema.jobs.id, id2))
      .get();
    expect(after1?.suitabilityComputedAt).toBeNull();
    expect(after2?.suitabilityComputedAt).toBeNull();
  });
});
