import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applicationService } from "./applications";

vi.mock("./settings", () => ({
  getEffectiveSettings: vi.fn(),
}));

describe.sequential("applicationService.getQueueStatus (US-012)", () => {
  let tempDir: string;
  let jobsRepo: any;
  let db: any;
  let schema: any;
  let applicationRepository: any;

  beforeEach(async () => {
    vi.resetModules();
    tempDir = await mkdtemp(join(tmpdir(), "jobops-queue-status-test-"));
    process.env.DATA_DIR = tempDir;
    process.env.NODE_ENV = "test";

    await import("../db/migrate");

    jobsRepo = await import("../repositories/jobs");
    const dbModule = await import("../db/index");
    db = dbModule.db;
    schema = dbModule.schema;
    applicationRepository = (await import("../repositories/applications"))
      .applicationRepository;
  });

  afterEach(async () => {
    const { closeDb } = await import("../db/index");
    closeDb();
    await rm(tempDir, { recursive: true, force: true });
  });

  async function insertJob(opts: {
    title: string;
    employer: string;
    jobUrl: string;
    autoApplicable?: boolean;
  }): Promise<string> {
    const job = await jobsRepo.createJob({
      source: "greenhouse",
      title: opts.title,
      employer: opts.employer,
      jobUrl: opts.jobUrl,
    });
    if (opts.autoApplicable) {
      db.update(schema.jobs)
        .set({ autoApplicable: true })
        .where(eq(schema.jobs.id, job.id))
        .run();
    }
    return job.id;
  }

  async function insertApp(
    jobId: string,
    status: "submitted" | "skipped" | "failed" | "preparing",
    updatedAt: string,
  ) {
    const app = applicationRepository.create({
      jobId,
      atsType: "greenhouse",
      status,
    });
    db.update(schema.applications)
      .set({ updatedAt })
      .where(eq(schema.applications.id, app.id))
      .run();
  }

  it("returns zeros and lastRunAt=null when there is no data at all", async () => {
    const result = await applicationService.getQueueStatus();
    expect(result).toEqual({
      counts: {
        pending: 0,
        submittedToday: 0,
        skippedToday: 0,
        failedToday: 0,
      },
      lastRunAt: null,
    });
  });

  it("counts pending as auto-applicable jobs that have no submitted/skipped application row", async () => {
    const now = new Date();
    const todayIso = now.toISOString();
    const yesterdayIso = new Date(
      now.getTime() - 24 * 60 * 60 * 1000,
    ).toISOString();

    // 3 auto-applicable, no application row → pending
    await insertJob({
      title: "A",
      employer: "Acme",
      jobUrl: "https://boards.greenhouse.io/acme/a",
      autoApplicable: true,
    });
    await insertJob({
      title: "B",
      employer: "Acme",
      jobUrl: "https://boards.greenhouse.io/acme/b",
      autoApplicable: true,
    });
    // 1 auto-applicable with a 'preparing' application → still pending
    const stillPending = await insertJob({
      title: "C",
      employer: "Acme",
      jobUrl: "https://boards.greenhouse.io/acme/c",
      autoApplicable: true,
    });
    await insertApp(stillPending, "preparing", todayIso);

    // 1 auto-applicable with submitted today → NOT pending
    const submittedJob = await insertJob({
      title: "D",
      employer: "Acme",
      jobUrl: "https://boards.greenhouse.io/acme/d",
      autoApplicable: true,
    });
    await insertApp(submittedJob, "submitted", todayIso);

    // 1 auto-applicable with skipped today → NOT pending
    const skippedJob = await insertJob({
      title: "E",
      employer: "Acme",
      jobUrl: "https://boards.greenhouse.io/acme/e",
      autoApplicable: true,
    });
    await insertApp(skippedJob, "skipped", todayIso);

    // 1 auto-applicable with submitted YESTERDAY → pending (status outside today)
    const oldSubmitted = await insertJob({
      title: "F",
      employer: "Acme",
      jobUrl: "https://boards.greenhouse.io/acme/f",
      autoApplicable: true,
    });
    await insertApp(oldSubmitted, "submitted", yesterdayIso);

    // 1 NOT auto-applicable with submitted today → not counted as pending
    const notApplicable = await insertJob({
      title: "G",
      employer: "Acme",
      jobUrl: "https://boards.greenhouse.io/acme/g",
      autoApplicable: false,
    });
    await insertApp(notApplicable, "submitted", todayIso);

    const result = await applicationService.getQueueStatus();
    // pending = A, B, C, F = 4
    expect(result.counts.pending).toBe(4);
    expect(result.counts.submittedToday).toBe(1);
    expect(result.counts.skippedToday).toBe(1);
    expect(result.counts.failedToday).toBe(0);
    expect(result.lastRunAt).toBe(todayIso);
  });

  it("counts today's failed applications and uses startOfToday (UTC)", async () => {
    const todayIso = new Date().toISOString();
    const job = await insertJob({
      title: "Job",
      employer: "Acme",
      jobUrl: "https://boards.greenhouse.io/acme/failed",
      autoApplicable: true,
    });
    await insertApp(job, "failed", todayIso);

    const result = await applicationService.getQueueStatus();
    expect(result.counts.failedToday).toBe(1);
    expect(result.counts.pending).toBe(1);
    expect(result.lastRunAt).toBe(todayIso);
  });
});
