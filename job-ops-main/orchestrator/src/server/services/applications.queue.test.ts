import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAppSettings } from "@shared/testing/factories";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./settings", () => ({
  getEffectiveSettings: vi.fn(),
}));

import {
  applicationService,
  clampQueueLimit,
  QUEUE_DEFAULT_LIMIT,
  QUEUE_MAX_LIMIT,
} from "./applications";
import { getEffectiveSettings } from "./settings";

describe.sequential("applicationService.getAutoApplicableQueue (US-010)", () => {
  let tempDir: string;
  let jobsRepo: any;
  let db: any;
  let schema: any;

  beforeEach(async () => {
    vi.resetModules();
    tempDir = await mkdtemp(join(tmpdir(), "job-ops-queue-test-"));
    process.env.DATA_DIR = tempDir;
    process.env.NODE_ENV = "test";

    await import("../db/migrate");

    jobsRepo = await import("../repositories/jobs");
    const dbModule = await import("../db/index");
    db = dbModule.db;
    schema = dbModule.schema;
  });

  afterEach(async () => {
    const { closeDb } = await import("../db/index");
    closeDb();
    await rm(tempDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  async function insertJob(opts: {
    title: string;
    employer: string;
    jobUrl: string;
    source?: string;
    autoApplicable?: boolean;
    suitabilityScore?: number;
  }): Promise<string> {
    const job = await jobsRepo.createJob({
      source: opts.source ?? "greenhouse",
      title: opts.title,
      employer: opts.employer,
      jobUrl: opts.jobUrl,
    });
    if (opts.autoApplicable || opts.suitabilityScore != null) {
      db.update(schema.jobs)
        .set({
          autoApplicable: opts.autoApplicable ?? false,
          suitabilityScore: opts.suitabilityScore ?? null,
        })
        .where(eq(schema.jobs.id, job.id))
        .run();
    }
    return job.id;
  }

  it("returns auto-applicable jobs ordered by suitabilityScore DESC, createdAt ASC, slim shape", async () => {
    vi.mocked(getEffectiveSettings).mockResolvedValue(
      createAppSettings({
        autoApplicationEnabled: { value: true, default: true, override: null },
      }) as any,
    );

    const highId = await insertJob({
      title: "Staff Engineer",
      employer: "Globex",
      jobUrl: "https://boards.greenhouse.io/globex/jobs/1",
      autoApplicable: true,
      suitabilityScore: 0.95,
    });
    await insertJob({
      title: "Senior Engineer",
      employer: "Acme",
      jobUrl: "https://boards.greenhouse.io/acme/jobs/2",
      autoApplicable: true,
      suitabilityScore: 0.8,
    });
    await insertJob({
      title: "Engineer",
      employer: "Initech",
      jobUrl: "https://boards.greenhouse.io/initech/jobs/3",
      autoApplicable: true,
      suitabilityScore: 0.4,
    });
    // Not auto-applicable — must be excluded.
    await insertJob({
      title: "Junior",
      employer: "Hooli",
      jobUrl: "https://boards.greenhouse.io/hooli/jobs/4",
      autoApplicable: false,
      suitabilityScore: 0.99,
    });

    const result = await applicationService.getAutoApplicableQueue(10);

    expect(result.jobs).toHaveLength(3);
    expect(result.jobs[0]).toEqual({
      id: highId,
      url: "https://boards.greenhouse.io/globex/jobs/1",
      atsType: "greenhouse",
      title: "Staff Engineer",
      employer: "Globex",
      suitabilityScore: 0.95,
    });
    expect(result.jobs[1].suitabilityScore).toBe(0.8);
    expect(result.jobs[2].suitabilityScore).toBe(0.4);
  });

  it("returns {jobs:[]} when no jobs are marked auto-applicable", async () => {
    vi.mocked(getEffectiveSettings).mockResolvedValue(
      createAppSettings({
        autoApplicationEnabled: { value: true, default: true, override: null },
      }) as any,
    );

    await insertJob({
      title: "Senior",
      employer: "Acme",
      jobUrl: "https://boards.greenhouse.io/acme/jobs/1",
      autoApplicable: false,
    });

    const result = await applicationService.getAutoApplicableQueue(10);
    expect(result).toEqual({ jobs: [] });
  });

  it("returns {jobs:[]} when autoApplicationEnabled is false (regardless of DB state)", async () => {
    vi.mocked(getEffectiveSettings).mockResolvedValue(
      createAppSettings({
        autoApplicationEnabled: {
          value: false,
          default: false,
          override: null,
        },
      }) as any,
    );

    await insertJob({
      title: "Senior",
      employer: "Acme",
      jobUrl: "https://boards.greenhouse.io/acme/jobs/1",
      autoApplicable: true,
      suitabilityScore: 0.9,
    });

    const result = await applicationService.getAutoApplicableQueue(10);
    expect(result).toEqual({ jobs: [] });
  });
});

describe("clampQueueLimit (US-010)", () => {
  it("uses the default when limit is not a positive finite number", () => {
    expect(clampQueueLimit(NaN)).toBe(QUEUE_DEFAULT_LIMIT);
    expect(clampQueueLimit(0)).toBe(QUEUE_DEFAULT_LIMIT);
    expect(clampQueueLimit(-5)).toBe(QUEUE_DEFAULT_LIMIT);
    expect(clampQueueLimit(Number.POSITIVE_INFINITY)).toBe(QUEUE_DEFAULT_LIMIT);
  });

  it("clamps values above QUEUE_MAX_LIMIT to QUEUE_MAX_LIMIT", () => {
    expect(clampQueueLimit(100)).toBe(QUEUE_MAX_LIMIT);
    expect(clampQueueLimit(QUEUE_MAX_LIMIT + 1)).toBe(QUEUE_MAX_LIMIT);
  });

  it("passes valid values through (floor)", () => {
    expect(clampQueueLimit(5)).toBe(5);
    expect(clampQueueLimit(QUEUE_MAX_LIMIT)).toBe(QUEUE_MAX_LIMIT);
    expect(clampQueueLimit(1)).toBe(1);
    expect(clampQueueLimit(3.7)).toBe(3);
  });
});
