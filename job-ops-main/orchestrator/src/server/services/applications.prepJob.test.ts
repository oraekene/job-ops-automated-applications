import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe.sequential("applicationService.prepJob (US-002)", () => {
  let tempDir: string;
  let jobsRepo: any;
  let applicationService: any;

  beforeEach(async () => {
    vi.resetModules();
    tempDir = await mkdtemp(join(tmpdir(), "job-ops-prepjob-test-"));
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

  it("returns exists:true with the matching job when a row with that URL exists", async () => {
    const greenhouseUrl = "https://boards.greenhouse.io/acme/jobs/12345";
    const job = await jobsRepo.createJob({
      source: "greenhouse",
      sourceJobId: "12345",
      title: "Senior Engineer",
      employer: "Acme",
      jobUrl: greenhouseUrl,
    });

    const result = await applicationService.prepJob(
      greenhouseUrl,
      "greenhouse",
    );

    expect(result.exists).toBe(true);
    expect(result.job).toEqual({
      id: job.id,
      title: "Senior Engineer",
      employer: "Acme",
      suitabilityScore: 0,
      status: "discovered",
    });
    expect(result.hasTailoredPdf).toBe(false);
    expect(result.applicationId).toBeNull();
  });

  it("normalizes query params / trailing slash when matching greenhouse/lever URLs", async () => {
    const stored = "https://boards.greenhouse.io/acme/jobs/12345";
    await jobsRepo.createJob({
      source: "greenhouse",
      title: "Staff Engineer",
      employer: "Acme",
      jobUrl: stored,
    });

    const resultWithQuery = await applicationService.prepJob(
      `${stored}?gh_jid=12345&utm_source=email`,
      "greenhouse",
    );
    expect(resultWithQuery.exists).toBe(true);

    const resultWithSlash = await applicationService.prepJob(
      `${stored}/`,
      "greenhouse",
    );
    expect(resultWithSlash.exists).toBe(true);
  });

  it("returns exists:false (no throw) when the URL is not in the jobs table", async () => {
    const result = await applicationService.prepJob(
      "https://example.com/not-a-job",
      "greenhouse",
    );

    expect(result.exists).toBe(false);
    expect(result.job).toBeUndefined();
    expect(result.hasTailoredPdf).toBe(false);
    expect(result.applicationId).toBeNull();
  });

  it("propagates a precomputed suitabilityScore when present on the job row", async () => {
    const url = "https://jobs.lever.co/globex/abc-1";
    await jobsRepo.createJob({
      source: "lever",
      title: "Platform Engineer",
      employer: "Globex",
      jobUrl: url,
    });
    // Manually patch the suitabilityScore so we can verify the field surfaces
    // (createJob does not take suitabilityScore; this mirrors what a previous
    // scoring step would have done.)
    const { db, schema } = await import("../db/index");
    const { eq } = await import("drizzle-orm");
    const inserted = await db
      .select()
      .from(schema.jobs)
      .where(eq(schema.jobs.jobUrl, url))
      .get();
    if (!inserted) throw new Error("Expected inserted job row to be present");
    db.update(schema.jobs)
      .set({ suitabilityScore: 0.87 })
      .where(eq(schema.jobs.id, inserted.id))
      .run();

    const result = await applicationService.prepJob(url, "lever");

    expect(result.exists).toBe(true);
    expect(result.job?.suitabilityScore).toBeCloseTo(0.87);
    expect(result.job?.status).toBe("discovered");
  });
});
