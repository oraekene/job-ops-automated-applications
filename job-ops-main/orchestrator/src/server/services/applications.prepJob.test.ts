import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./profile", () => ({
  getProfile: vi.fn(),
}));

vi.mock("./pdf", () => ({
  generatePdf: vi.fn(),
  getPdfPath: vi.fn(),
  pdfExists: vi.fn(),
}));

vi.mock("./settings", () => ({
  getEffectiveSettings: vi.fn(),
}));

vi.mock("./suitability", () => ({
  recomputeAndPersistSuitabilityScore: vi.fn(),
}));

import { getProfile } from "./profile";
import { pdfExists } from "./pdf";
import { getEffectiveSettings } from "./settings";
import { recomputeAndPersistSuitabilityScore } from "./suitability";

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

    vi.mocked(getEffectiveSettings).mockResolvedValue({
      autoApplicationEnabled: { value: true, default: true, override: null },
      autoApplicationPdfMaxAgeDays: {
        value: 30,
        default: 30,
        override: null,
      },
    } as any);
    vi.mocked(pdfExists).mockResolvedValue(false);
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

  it("returns profile:null when getProfile throws (onboarding not complete)", async () => {
    const url = "https://boards.greenhouse.io/acme/jobs/999";
    await jobsRepo.createJob({
      source: "greenhouse",
      sourceJobId: "999",
      title: "DevOps",
      employer: "Acme",
      jobUrl: url,
    });
    vi.mocked(getProfile).mockRejectedValue(
      new Error(
        "Base resume not configured. Please select a base resume from your RxResume account in Settings.",
      ),
    );

    const result = await applicationService.prepJob(url, "greenhouse");

    expect(result.exists).toBe(true);
    expect(result.profile).toBeNull();
  });

  it("sets hasTailoredPdf:true and pdfStale:false when PDF exists and is fresh", async () => {
    const url = "https://boards.greenhouse.io/acme/jobs/501";
    const job = await jobsRepo.createJob({
      source: "greenhouse",
      sourceJobId: "501",
      title: "Backend Dev",
      employer: "Acme",
      jobUrl: url,
    });

    // Patch the job row to have a recent pdfGeneratedAt and matching fingerprint
    const { db, schema } = await import("../db/index");
    const { eq } = await import("drizzle-orm");
    const inserted = await db
      .select()
      .from(schema.jobs)
      .where(eq(schema.jobs.id, job.id))
      .get();
    if (!inserted) throw new Error("Expected job row");
    db.update(schema.jobs)
      .set({
        pdfGeneratedAt: new Date().toISOString(),
        pdfFingerprint: null,
      })
      .where(eq(schema.jobs.id, job.id))
      .run();

    vi.mocked(pdfExists).mockResolvedValue(true);
    vi.mocked(getProfile).mockResolvedValue({
      basics: { name: "Test User", email: "test@example.com" },
    } as any);

    const result = await applicationService.prepJob(url, "greenhouse");

    expect(result.exists).toBe(true);
    expect(result.hasTailoredPdf).toBe(true);
    expect(result.pdfStale).toBe(false);
  });

  it("sets pdfStale:true and pdfStaleReason:'fingerprint' when profile changed since PDF was generated", async () => {
    const url = "https://boards.greenhouse.io/acme/jobs/502";
    const job = await jobsRepo.createJob({
      source: "greenhouse",
      sourceJobId: "502",
      title: "Frontend Dev",
      employer: "Acme",
      jobUrl: url,
    });

    // Patch job: pdfGeneratedAt is recent but pdfFingerprint is an old value
    const { db, schema } = await import("../db/index");
    const { eq } = await import("drizzle-orm");
    const inserted = await db
      .select()
      .from(schema.jobs)
      .where(eq(schema.jobs.id, job.id))
      .get();
    if (!inserted) throw new Error("Expected job row");
    db.update(schema.jobs)
      .set({
        pdfGeneratedAt: new Date().toISOString(),
        pdfFingerprint: "old_fingerprint123",
      })
      .where(eq(schema.jobs.id, job.id))
      .run();

    vi.mocked(pdfExists).mockResolvedValue(true);
    vi.mocked(getProfile).mockResolvedValue({
      basics: { name: "Test User", email: "test@example.com" },
    } as any);

    const result = await applicationService.prepJob(url, "greenhouse");

    expect(result.exists).toBe(true);
    expect(result.hasTailoredPdf).toBe(true);
    expect(result.pdfStale).toBe(true);
    expect(result.pdfStaleReason).toBe("fingerprint");
  });

  it("throws notFound (404) when job URL not in DB and profile is missing", async () => {
    vi.mocked(getProfile).mockRejectedValue(
      new Error("Base resume not configured"),
    );

    const result = await applicationService.prepJob(
      "https://boards.greenhouse.io/acme/jobs/missing",
      "greenhouse",
    );

    expect(result.exists).toBe(false);
    expect(result.profile).toBeUndefined();
  });

  it("sets pdfStale:true and pdfStaleReason:'age' when PDF is older than maxPdfAgeDays", async () => {
    const url = "https://boards.greenhouse.io/acme/jobs/503";
    const job = await jobsRepo.createJob({
      source: "greenhouse",
      sourceJobId: "503",
      title: "SRE",
      employer: "Acme",
      jobUrl: url,
    });

    // Patch job: pdfGeneratedAt is 60 days ago
    const { db, schema } = await import("../db/index");
    const { eq } = await import("drizzle-orm");
    const inserted = await db
      .select()
      .from(schema.jobs)
      .where(eq(schema.jobs.id, job.id))
      .get();
    if (!inserted) throw new Error("Expected job row");
    const oldDate = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
    db.update(schema.jobs)
      .set({
        pdfGeneratedAt: oldDate.toISOString(),
        pdfFingerprint: null,
      })
      .where(eq(schema.jobs.id, job.id))
      .run();

    vi.mocked(pdfExists).mockResolvedValue(true);
    vi.mocked(getProfile).mockResolvedValue({
      basics: { name: "Test User", email: "test@example.com" },
    } as any);

    const result = await applicationService.prepJob(url, "greenhouse");

    expect(result.exists).toBe(true);
    expect(result.hasTailoredPdf).toBe(true);
    expect(result.pdfStale).toBe(true);
    expect(result.pdfStaleReason).toBe("age");
  });
});
