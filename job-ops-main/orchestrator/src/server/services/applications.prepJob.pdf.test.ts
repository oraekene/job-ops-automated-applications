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

vi.mock("./pdf", () => ({
  pdfExists: vi.fn().mockResolvedValue(false),
}));

vi.mock("./settings", () => ({
  getEffectiveSettings: vi.fn().mockResolvedValue({
    autoApplicationPdfMaxAgeDays: { value: 7, default: 7, override: null },
  }),
}));

import { pdfExists } from "./pdf";
import { getProfile } from "./profile";
import { scoreJobSuitability } from "./scorer";

describe.sequential("applicationService.prepJob pdfFreshness (US-005)", () => {
  let tempDir: string;
  let jobsRepo: any;
  let applicationService: any;

  beforeEach(async () => {
    vi.resetModules();
    tempDir = await mkdtemp(join(tmpdir(), "job-ops-prepjob-pdf-test-"));
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

  it("returns hasTailoredPdf:true and pdfFreshness from the job row when a PDF was generated 2h ago", async () => {
    const url = "https://boards.greenhouse.io/acme/jobs/12345";
    await jobsRepo.createJob({
      source: "greenhouse",
      sourceJobId: "12345",
      title: "Senior Engineer",
      employer: "Acme",
      jobUrl: url,
    });

    const generatedAt = "2026-06-02T12:00:00.000Z";
    const { db, schema } = await import("../db/index");
    const { eq } = await import("drizzle-orm");
    const inserted = await db
      .select()
      .from(schema.jobs)
      .where(eq(schema.jobs.jobUrl, url))
      .get();
    if (!inserted) throw new Error("Expected inserted job row");
    db.update(schema.jobs)
      .set({ pdfGeneratedAt: generatedAt })
      .where(eq(schema.jobs.id, inserted.id))
      .run();

    vi.mocked(getProfile).mockRejectedValue(new Error("no profile"));
    vi.mocked(pdfExists).mockResolvedValue(true);
    vi.mocked(scoreJobSuitability).mockResolvedValue({
      score: 0,
      reason: "no profile",
    });

    const result = await applicationService.prepJob(url, "greenhouse");

    expect(result.hasTailoredPdf).toBe(true);
    expect(result.pdfFreshness).toBe(generatedAt);
  });

  it("returns hasTailoredPdf:false and pdfFreshness:undefined when no PDF exists for the job", async () => {
    const url = "https://boards.greenhouse.io/acme/jobs/12345";
    await jobsRepo.createJob({
      source: "greenhouse",
      sourceJobId: "12345",
      title: "Senior Engineer",
      employer: "Acme",
      jobUrl: url,
    });

    vi.mocked(getProfile).mockRejectedValue(new Error("no profile"));
    vi.mocked(pdfExists).mockResolvedValue(false);
    vi.mocked(scoreJobSuitability).mockResolvedValue({
      score: 0,
      reason: "no profile",
    });

    const result = await applicationService.prepJob(url, "greenhouse");

    expect(result.hasTailoredPdf).toBe(false);
    expect(result.pdfFreshness).toBeNull();
  });

  it("returns hasTailoredPdf:false when the file is missing on disk even if the row has a stale timestamp", async () => {
    const url = "https://boards.greenhouse.io/acme/jobs/12345";
    await jobsRepo.createJob({
      source: "greenhouse",
      sourceJobId: "12345",
      title: "Senior Engineer",
      employer: "Acme",
      jobUrl: url,
    });

    const generatedAt = "2026-06-02T12:00:00.000Z";
    const { db, schema } = await import("../db/index");
    const { eq } = await import("drizzle-orm");
    const inserted = await db
      .select()
      .from(schema.jobs)
      .where(eq(schema.jobs.jobUrl, url))
      .get();
    if (!inserted) throw new Error("Expected inserted job row");
    db.update(schema.jobs)
      .set({ pdfGeneratedAt: generatedAt })
      .where(eq(schema.jobs.id, inserted.id))
      .run();

    vi.mocked(getProfile).mockRejectedValue(new Error("no profile"));
    vi.mocked(pdfExists).mockResolvedValue(false);
    vi.mocked(scoreJobSuitability).mockResolvedValue({
      score: 0,
      reason: "no profile",
    });

    const result = await applicationService.prepJob(url, "greenhouse");

    expect(result.hasTailoredPdf).toBe(false);
    expect(result.pdfFreshness).toBeNull();
  });
});
