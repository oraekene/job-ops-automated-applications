import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe.sequential("applicationService.reportQueueResult (US-011)", () => {
  let tempDir: string;
  let jobsRepo: any;
  let applicationService: any;
  let applicationRepository: any;

  beforeEach(async () => {
    vi.resetModules();
    tempDir = await mkdtemp(join(tmpdir(), "job-ops-queue-result-test-"));
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

  it("creates an application row with status='submitted' and persists the confirmation fields", async () => {
    const job = await jobsRepo.createJob({
      source: "greenhouse",
      title: "Senior Engineer",
      employer: "Acme",
      jobUrl: "https://boards.greenhouse.io/acme/jobs/1",
    });

    const result = await applicationService.reportQueueResult({
      jobId: job.id,
      atsType: "greenhouse",
      outcome: "submitted",
      confirmationId: "gh-conf-abc",
      submittedAt: "2026-06-04T12:00:00.000Z",
      fieldSnapshot: { first_name: "Ada" },
      answersSnapshot: { q1: "Yes" },
    });

    expect(result.applicationId).toMatch(/^app_/);
    expect(result.newStatus).toBe("submitted");

    const row = applicationRepository.findByJobId(job.id);
    expect(row).toBeDefined();
    expect(row?.status).toBe("submitted");
    expect(row?.confirmationId).toBe("gh-conf-abc");
    expect(row?.submittedAt).toBe("2026-06-04T12:00:00.000Z");
    expect(row?.errorMessage).toBeNull();
    expect(JSON.parse(row?.fieldPayload ?? "{}")).toEqual({
      first_name: "Ada",
    });
    expect(JSON.parse(row?.screeningAnswers ?? "{}")).toEqual({ q1: "Yes" });
  });

  it("creates a row with status='skipped' and stores reason in errorMessage", async () => {
    const job = await jobsRepo.createJob({
      source: "lever",
      title: "Platform Engineer",
      employer: "Globex",
      jobUrl: "https://jobs.lever.co/globex/abc-1",
    });

    const result = await applicationService.reportQueueResult({
      jobId: job.id,
      atsType: "lever",
      outcome: "skipped",
      reason: "no resume upload input",
    });

    expect(result.newStatus).toBe("skipped");
    const row = applicationRepository.findByJobId(job.id);
    expect(row?.status).toBe("skipped");
    expect(row?.errorMessage).toBe("no resume upload input");
    expect(row?.confirmationId).toBeNull();
    expect(row?.submittedAt).toBeNull();
  });

  it("creates a row with status='failed' and stores reason in errorMessage", async () => {
    const job = await jobsRepo.createJob({
      source: "greenhouse",
      title: "Engineer",
      employer: "Hooli",
      jobUrl: "https://boards.greenhouse.io/hooli/jobs/1",
    });

    const result = await applicationService.reportQueueResult({
      jobId: job.id,
      atsType: "greenhouse",
      outcome: "failed",
      reason: "server error",
    });

    expect(result.newStatus).toBe("failed");
    const row = applicationRepository.findByJobId(job.id);
    expect(row?.status).toBe("failed");
    expect(row?.errorMessage).toBe("server error");
  });

  it("throws notFound when the jobId does not exist in the jobs table", async () => {
    await expect(
      applicationService.reportQueueResult({
        jobId: "nonexistent_job_id",
        atsType: "greenhouse",
        outcome: "skipped",
        reason: "x",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("updates an existing application row (does not create a duplicate) when called twice", async () => {
    const job = await jobsRepo.createJob({
      source: "greenhouse",
      title: "Engineer",
      employer: "Initech",
      jobUrl: "https://boards.greenhouse.io/initech/jobs/1",
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
});
