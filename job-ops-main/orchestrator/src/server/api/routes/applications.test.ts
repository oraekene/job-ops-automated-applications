import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startServer, stopServer } from "./test-utils";

describe.sequential("Applications API routes", () => {
  let server: Server;
  let baseUrl: string;
  let closeDb: () => void;
  let tempDir: string;

  const JOB_URL = "https://example.com/job/test-role";
  const ATS = "greenhouse";

  beforeEach(async () => {
    vi.clearAllMocks();
    ({ server, baseUrl, closeDb, tempDir } = await startServer());
  });

  afterEach(async () => {
    await stopServer({ server, closeDb, tempDir });
  });

  async function createTestJob() {
    const { createJob } = await import("@server/repositories/jobs");
    return createJob({
      source: "manual",
      title: "Test Role",
      employer: "Acme",
      jobUrl: JOB_URL,
      jobDescription: "Test description",
    });
  }

  describe("GET /prep", () => {
    it("returns 400 when url parameter is missing", async () => {
      const res = await fetch(`${baseUrl}/api/applications/prep?ats=${ATS}`);
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe("INVALID_REQUEST");
      expect(typeof body.meta.requestId).toBe("string");
    });

    it("returns 400 when ats parameter is missing", async () => {
      const res = await fetch(
        `${baseUrl}/api/applications/prep?url=${encodeURIComponent(JOB_URL)}`,
      );
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe("INVALID_REQUEST");
      expect(typeof body.meta.requestId).toBe("string");
    });

    it("returns exists false for an unknown url", async () => {
      const res = await fetch(
        `${baseUrl}/api/applications/prep?url=${encodeURIComponent(JOB_URL)}&ats=${ATS}`,
      );
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.data.exists).toBe(false);
      expect(typeof body.meta.requestId).toBe("string");
    });

    it("returns job prep info for a known url", async () => {
      const job = await createTestJob();
      const { getProfile } = await import("@server/services/profile");
      vi.mocked(getProfile).mockResolvedValue({
        basics: { name: "Jane Doe", email: "jane@example.com" },
      } as any);

      const res = await fetch(
        `${baseUrl}/api/applications/prep?url=${encodeURIComponent(JOB_URL)}&ats=${ATS}`,
      );
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.data.exists).toBe(true);
      expect(body.data.job).toMatchObject({
        id: job.id,
        title: "Test Role",
        employer: "Acme",
      });
      expect(body.data.profile).toMatchObject({
        first_name: "Jane",
        last_name: "Doe",
        email: "jane@example.com",
      });
      expect(typeof body.data.suitabilityStale).toBe("boolean");
      expect(typeof body.data.hasTailoredPdf).toBe("boolean");
      expect(typeof body.data.pdfStale).toBe("boolean");
      expect(typeof body.meta.requestId).toBe("string");
    });
  });

  describe("POST /payload", () => {
    it("returns 400 when jobId is missing", async () => {
      const res = await fetch(`${baseUrl}/api/applications/payload`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ atsType: ATS }),
      });
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe("INVALID_REQUEST");
      expect(typeof body.meta.requestId).toBe("string");
    });

    it("returns 400 when atsType is missing", async () => {
      const res = await fetch(`${baseUrl}/api/applications/payload`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId: "job-1" }),
      });
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe("INVALID_REQUEST");
      expect(typeof body.meta.requestId).toBe("string");
    });

    it("returns 404 when profile is not loaded (incomplete onboarding)", async () => {
      const job = await createTestJob();

      const res = await fetch(`${baseUrl}/api/applications/payload`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId: job.id, atsType: ATS }),
      });
      const body = await res.json();

      expect(res.status).toBe(404);
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe("NOT_FOUND");
      expect(body.error.message).toMatch(/profile/i);
      expect(typeof body.meta.requestId).toBe("string");
    });
  });

  describe("POST /confirm", () => {
    it("returns 400 when jobId is missing", async () => {
      const res = await fetch(`${baseUrl}/api/applications/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ applicationId: "app-1" }),
      });
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe("INVALID_REQUEST");
      expect(typeof body.meta.requestId).toBe("string");
    });

    it("returns 404 when application does not exist", async () => {
      const res = await fetch(`${baseUrl}/api/applications/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId: "nonexistent" }),
      });
      const body = await res.json();

      expect(res.status).toBe(404);
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe("NOT_FOUND");
      expect(typeof body.meta.requestId).toBe("string");
    });

    it("confirms a submitted application", async () => {
      const job = await createTestJob();
      const { applicationRepository } = await import(
        "@server/repositories/applications"
      );
      const app = applicationRepository.create({
        jobId: job.id,
        atsType: "greenhouse",
        status: "ready_for_review",
      });

      const res = await fetch(`${baseUrl}/api/applications/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jobId: job.id,
          applicationId: app.id,
          confirmationId: "conf-123",
          submittedAt: new Date().toISOString(),
          fieldSnapshot: { first_name: "Jane" },
          answersSnapshot: { q1: "A1" },
          screenshotBase64: "iVBORw0KGgo=",
        }),
      });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.data).toEqual({
        updated: true,
        newStatus: "applied",
      });
      expect(typeof body.meta.requestId).toBe("string");
    });
  });

  describe("GET /pending", () => {
    it("returns an empty list when no pending applications exist", async () => {
      const res = await fetch(`${baseUrl}/api/applications/pending`);
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.data.applications).toEqual([]);
      expect(typeof body.meta.requestId).toBe("string");
    });

    it("returns pending applications that are ready for review", async () => {
      const job = await createTestJob();
      const { applicationRepository } = await import(
        "@server/repositories/applications"
      );
      applicationRepository.create({
        jobId: job.id,
        atsType: "greenhouse",
        status: "ready_for_review",
      });

      const res = await fetch(`${baseUrl}/api/applications/pending`);
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.data.applications).toHaveLength(1);
      expect(body.data.applications[0].jobId).toBe(job.id);
      expect(body.data.applications[0].status).toBe("ready_for_review");
      expect(typeof body.meta.requestId).toBe("string");
    });
  });

  describe("GET /queue", () => {
    it("returns the queue with the default limit", async () => {
      const res = await fetch(`${baseUrl}/api/applications/queue`);
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(Array.isArray(body.data.jobs)).toBe(true);
      expect(typeof body.meta.requestId).toBe("string");
    });

    it("accepts a custom limit query parameter", async () => {
      const res = await fetch(`${baseUrl}/api/applications/queue?limit=5`);
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(Array.isArray(body.data.jobs)).toBe(true);
      expect(typeof body.meta.requestId).toBe("string");
    });

    it("handles a non-numeric limit gracefully", async () => {
      const res = await fetch(`${baseUrl}/api/applications/queue?limit=abc`);
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(Array.isArray(body.data.jobs)).toBe(true);
      expect(typeof body.meta.requestId).toBe("string");
    });
  });

  describe("POST /queue-result", () => {
    it("returns 400 when jobId is missing", async () => {
      const res = await fetch(`${baseUrl}/api/applications/queue-result`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ atsType: ATS, outcome: "submitted" }),
      });
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe("INVALID_REQUEST");
      expect(typeof body.meta.requestId).toBe("string");
    });

    it("returns 400 when atsType is missing", async () => {
      const res = await fetch(`${baseUrl}/api/applications/queue-result`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId: "job-1", outcome: "submitted" }),
      });
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe("INVALID_REQUEST");
      expect(typeof body.meta.requestId).toBe("string");
    });

    it("returns 400 when outcome is missing", async () => {
      const res = await fetch(`${baseUrl}/api/applications/queue-result`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId: "job-1", atsType: ATS }),
      });
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe("INVALID_REQUEST");
      expect(typeof body.meta.requestId).toBe("string");
    });

    it("returns 400 for an invalid outcome value", async () => {
      const res = await fetch(`${baseUrl}/api/applications/queue-result`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jobId: "job-1",
          atsType: ATS,
          outcome: "invalid",
        }),
      });
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe("INVALID_REQUEST");
      expect(body.error.message).toMatch(/outcome/i);
      expect(typeof body.meta.requestId).toBe("string");
    });

    it("returns 404 for an unknown job", async () => {
      const res = await fetch(`${baseUrl}/api/applications/queue-result`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jobId: "nonexistent",
          atsType: ATS,
          outcome: "submitted",
        }),
      });
      const body = await res.json();

      expect(res.status).toBe(404);
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe("NOT_FOUND");
      expect(typeof body.meta.requestId).toBe("string");
    });

    it("reports a submitted outcome", async () => {
      const job = await createTestJob();

      const res = await fetch(`${baseUrl}/api/applications/queue-result`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jobId: job.id,
          atsType: ATS,
          outcome: "submitted",
          confirmationId: "conf-456",
          submittedAt: new Date().toISOString(),
          fieldSnapshot: { first_name: "Jane" },
          answersSnapshot: { q1: "A1" },
          screenshotBase64: "iVBORw0KGgo=",
        }),
      });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.data).toMatchObject({
        newStatus: "submitted",
      });
      expect(typeof body.data.applicationId).toBe("string");
      expect(typeof body.meta.requestId).toBe("string");
    });

    it("reports a skipped outcome", async () => {
      const job = await createTestJob();

      const res = await fetch(`${baseUrl}/api/applications/queue-result`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jobId: job.id,
          atsType: ATS,
          outcome: "skipped",
          reason: "Salary expectation mismatch",
        }),
      });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.data).toMatchObject({
        newStatus: "skipped",
      });
      expect(typeof body.data.applicationId).toBe("string");
      expect(typeof body.meta.requestId).toBe("string");
    });

    it("reports a failed outcome", async () => {
      const job = await createTestJob();

      const res = await fetch(`${baseUrl}/api/applications/queue-result`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jobId: job.id,
          atsType: ATS,
          outcome: "failed",
          reason: "CAPTCHA encountered",
        }),
      });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.data).toMatchObject({
        newStatus: "failed",
      });
      expect(typeof body.data.applicationId).toBe("string");
      expect(typeof body.meta.requestId).toBe("string");
    });
  });

  describe("GET /queue/status", () => {
    it("returns queue status with counts", async () => {
      const res = await fetch(`${baseUrl}/api/applications/queue/status`);
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.data).toMatchObject({
        counts: {
          pending: expect.any(Number),
          submittedToday: expect.any(Number),
          skippedToday: expect.any(Number),
          failedToday: expect.any(Number),
        },
      });
      expect(
        body.data.lastRunAt === null || typeof body.data.lastRunAt === "string",
      ).toBe(true);
      expect(typeof body.meta.requestId).toBe("string");
    });
  });
});
