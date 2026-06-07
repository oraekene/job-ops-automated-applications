import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe.sequential("applicationService.reportQueueResult job-pointer + cleanup (US-035)", () => {
  let tempDir: string;
  let jobsRepo: any;
  let applicationService: any;
  let applicationRepository: any;

  beforeEach(async () => {
    vi.resetModules();
    tempDir = await mkdtemp(join(tmpdir(), "job-ops-record-queue-result-test-"));
    process.env.DATA_DIR = tempDir;
    process.env.NODE_ENV = "test";

    await import("../db/migrate");

    jobsRepo = await import("../repositories/jobs");
    applicationService = (await import("./applications")).applicationService;
    applicationRepository = (await import("../repositories/applications"))
      .applicationRepository;
  });

  afterEach(async () => {
    const { closeDb } = await import("../db/index");
    closeDb();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("on submitted: creates the application row, sets jobs.lastApplicationId, and clears jobs.autoApplicable", async () => {
    const job = await jobsRepo.createJob({
      source: "greenhouse",
      title: "Senior Engineer",
      employer: "Acme",
      jobUrl: "https://boards.greenhouse.io/acme/jobs/1",
      autoApplicable: true,
    });
    expect(job.autoApplicable).toBe(true);

    const result = await applicationService.reportQueueResult({
      jobId: job.id,
      atsType: "greenhouse",
      outcome: "submitted",
      confirmationId: "gh-conf-abc",
      submittedAt: "2026-06-04T12:00:00.000Z",
    });

    expect(result.applicationId).toMatch(/^app_/);
    expect(result.newStatus).toBe("submitted");

    const updated = await jobsRepo.getJobById(job.id);
    expect(updated?.lastApplicationId).toBe(result.applicationId);
    expect(updated?.autoApplicable).toBe(false);
  });

  it("on skipped: creates a row with the reason, sets jobs.lastApplicationId, and clears jobs.autoApplicable", async () => {
    const job = await jobsRepo.createJob({
      source: "lever",
      title: "Platform Engineer",
      employer: "Globex",
      jobUrl: "https://jobs.lever.co/globex/abc-1",
      autoApplicable: true,
    });

    const result = await applicationService.reportQueueResult({
      jobId: job.id,
      atsType: "lever",
      outcome: "skipped",
      reason: "no resume upload input",
    });

    expect(result.newStatus).toBe("skipped");
    const row = applicationRepository.findByJobId(job.id);
    expect(row?.errorMessage).toBe("no resume upload input");

    const updated = await jobsRepo.getJobById(job.id);
    expect(updated?.lastApplicationId).toBe(result.applicationId);
    expect(updated?.autoApplicable).toBe(false);
  });

  it("on failed: creates a row with the reason, sets jobs.lastApplicationId, and clears jobs.autoApplicable", async () => {
    const job = await jobsRepo.createJob({
      source: "greenhouse",
      title: "Engineer",
      employer: "Hooli",
      jobUrl: "https://boards.greenhouse.io/hooli/jobs/1",
      autoApplicable: true,
    });

    const result = await applicationService.reportQueueResult({
      jobId: job.id,
      atsType: "greenhouse",
      outcome: "failed",
      reason: "server error",
    });

    expect(result.newStatus).toBe("failed");
    const row = applicationRepository.findByJobId(job.id);
    expect(row?.errorMessage).toBe("server error");

    const updated = await jobsRepo.getJobById(job.id);
    expect(updated?.lastApplicationId).toBe(result.applicationId);
    expect(updated?.autoApplicable).toBe(false);
  });

  it("is idempotent: a second reportQueueResult for the same job updates the existing row (no duplicate)", async () => {
    const job = await jobsRepo.createJob({
      source: "greenhouse",
      title: "Engineer",
      employer: "Initech",
      jobUrl: "https://boards.greenhouse.io/initech/jobs/1",
      autoApplicable: true,
    });

    const first = await applicationService.reportQueueResult({
      jobId: job.id,
      atsType: "greenhouse",
      outcome: "skipped",
      reason: "transient",
    });
    const second = await applicationService.reportQueueResult({
      jobId: job.id,
      atsType: "greenhouse",
      outcome: "failed",
      reason: "persistent",
    });

    expect(second.applicationId).toBe(first.applicationId);
    const row = applicationRepository.findByJobId(job.id);
    expect(row?.errorMessage).toBe("persistent");
  });

  it("throws notFound (404) when the jobId does not exist in the jobs table", async () => {
    await expect(
      applicationService.reportQueueResult({
        jobId: "nonexistent_job_id",
        atsType: "greenhouse",
        outcome: "skipped",
        reason: "x",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
