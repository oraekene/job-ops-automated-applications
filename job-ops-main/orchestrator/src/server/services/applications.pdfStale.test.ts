import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getProfileMock = vi.hoisted(() => vi.fn());

vi.mock("./profile", () => ({
  getProfile: getProfileMock,
  invalidateProfileCache: vi.fn(),
  refreshProfile: vi.fn(),
  onProfileChange: vi.fn(),
}));

describe.sequential("applicationService.prepJob PDF staleness (US-031)", () => {
  let tempDir: string;
  let jobsRepo: any;
  let applicationService: typeof import("./applications").applicationService;

  beforeEach(async () => {
    vi.resetModules();
    getProfileMock.mockReset();
    tempDir = await mkdtemp(join(tmpdir(), "job-ops-pdfstale-test-"));
    process.env.DATA_DIR = tempDir;
    process.env.NODE_ENV = "test";
    process.env.TENANT_ID = "tenant_default";

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

  async function writeRealPdfFile(jobId: string): Promise<void> {
    const pdfDir = join(tempDir, "pdfs", "tenant_default");
    await mkdir(pdfDir, { recursive: true });
    const pdfPath = join(pdfDir, `resume_${jobId}.pdf`);
    const content = Buffer.concat([
      Buffer.from("%PDF-1.4\n"),
      Buffer.from("x".repeat(2048)),
      Buffer.from("\n%%EOF"),
    ]);
    await writeFile(pdfPath, content);
  }

  async function patchJobPdfFields(
    jobId: string,
    fields: {
      pdfGeneratedAt: string | null;
      pdfFingerprint: string | null;
      pdfRegenerating?: boolean;
    },
  ): Promise<void> {
    const { db, schema } = await import("../db/index");
    const { eq } = await import("drizzle-orm");
    db.update(schema.jobs)
      .set({
        pdfGeneratedAt: fields.pdfGeneratedAt,
        pdfFingerprint: fields.pdfFingerprint,
        pdfRegenerating: fields.pdfRegenerating ?? false,
      })
      .where(eq(schema.jobs.id, jobId))
      .run();
  }

  function daysAgoIso(days: number): string {
    return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  }

  it("marks PDF stale with reason 'age' when older than autoApplicationPdfMaxAgeDays", async () => {
    getProfileMock.mockResolvedValue({ basics: { name: "Alice" } });
    const job = await jobsRepo.createJob({
      source: "greenhouse",
      title: "Stale Age Job",
      employer: "Acme",
      jobUrl: "https://boards.greenhouse.io/acme/jobs/stale-age-1",
    });
    await patchJobPdfFields(job.id, {
      pdfGeneratedAt: daysAgoIso(30),
      pdfFingerprint: "fingerprint-current",
    });
    await writeRealPdfFile(job.id);

    const result = await applicationService.prepJob(job.jobUrl, "greenhouse");

    expect(result.exists).toBe(true);
    expect(result.hasTailoredPdf).toBe(true);
    expect(result.pdfStale).toBe(true);
    expect(result.pdfStaleReason).toBe("age");
  });

  it("marks PDF stale with reason 'fingerprint' when the base resume has changed", async () => {
    getProfileMock.mockResolvedValue({ basics: { name: "Alice v2" } });
    const job = await jobsRepo.createJob({
      source: "greenhouse",
      title: "Fingerprint Mismatch Job",
      employer: "Acme",
      jobUrl: "https://boards.greenhouse.io/acme/jobs/stale-fp-1",
    });
    await patchJobPdfFields(job.id, {
      pdfGeneratedAt: daysAgoIso(1),
      pdfFingerprint: "stale-fingerprint-from-yesterday",
    });
    await writeRealPdfFile(job.id);

    const result = await applicationService.prepJob(job.jobUrl, "greenhouse");

    expect(result.exists).toBe(true);
    expect(result.hasTailoredPdf).toBe(true);
    expect(result.pdfStale).toBe(true);
    expect(result.pdfStaleReason).toBe("fingerprint");
  });

  it("returns hasTailoredPdf=false and pdfStale=false when pdfRegenerating=true", async () => {
    getProfileMock.mockResolvedValue({ basics: { name: "Alice" } });
    const job = await jobsRepo.createJob({
      source: "greenhouse",
      title: "Regenerating Job",
      employer: "Acme",
      jobUrl: "https://boards.greenhouse.io/acme/jobs/regen-1",
    });
    await patchJobPdfFields(job.id, {
      pdfGeneratedAt: daysAgoIso(1),
      pdfFingerprint: "fp-during-regen",
      pdfRegenerating: true,
    });
    await writeRealPdfFile(job.id);

    const result = await applicationService.prepJob(job.jobUrl, "greenhouse");

    expect(result.exists).toBe(true);
    expect(result.hasTailoredPdf).toBe(false);
    expect(result.pdfFreshness).toBeNull();
    expect(result.pdfStale).toBe(false);
  });

  it("returns pdfStale=false (negative) when the job has no PDF at all", async () => {
    getProfileMock.mockResolvedValue({ basics: { name: "Alice" } });
    const job = await jobsRepo.createJob({
      source: "greenhouse",
      title: "No PDF Job",
      employer: "Acme",
      jobUrl: "https://boards.greenhouse.io/acme/jobs/no-pdf-1",
    });

    const result = await applicationService.prepJob(job.jobUrl, "greenhouse");

    expect(result.exists).toBe(true);
    expect(result.hasTailoredPdf).toBe(false);
    expect(result.pdfStale).toBe(false);
    expect(result.pdfStaleReason).toBeUndefined();
  });
});
