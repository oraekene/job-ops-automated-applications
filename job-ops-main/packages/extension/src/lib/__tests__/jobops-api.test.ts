import { beforeEach, describe, expect, it, vi } from "vitest";
import { JobOpsApi } from "../jobops-api";

describe("JobOpsApi", () => {
	const api = new JobOpsApi("http://localhost:3005");

	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it("prepJob calls correct endpoint and returns prep data", async () => {
		const mockResponse = {
			ok: true,
			data: { exists: true, job: { id: "job1" }, hasTailoredPdf: true },
		};
		global.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: () => Promise.resolve(mockResponse),
		});
		const result = await api.prepJob(
			"https://boards.greenhouse.io/company/1",
			"greenhouse",
		);
		expect(result.exists).toBe(true);
	});

	it("buildPayload sends custom questions and receives fill payload", async () => {
		const mockPayload = {
			ok: true,
			data: {
				applicationId: "app1",
				fields: { first_name: "John" },
				cover_letter: "...",
				screening_answers: {},
				resume_pdf_base64: "JVBER",
				resume_filename: "resume.pdf",
			},
		};
		global.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: () => Promise.resolve(mockPayload),
		});
		const result = await api.buildPayload("job1", "greenhouse", ["Why you?"]);
		expect(result.applicationId).toBe("app1");
	});

	it("confirmSubmission posts confirmation data", async () => {
		global.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: () =>
				Promise.resolve({
					ok: true,
					data: { updated: true, newStatus: "applied" },
				}),
		});
		const result = await api.confirmSubmission({
			jobId: "job1",
			applicationId: "app1",
			atsType: "greenhouse",
			confirmationId: "123",
			submittedAt: new Date().toISOString(),
			fieldSnapshot: {},
			answersSnapshot: {},
			screenshotBase64: "",
		});
		expect(result.updated).toBe(true);
	});

	it("throws on API error response", async () => {
		global.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: () =>
				Promise.resolve({
					ok: false,
					error: { code: "NOT_FOUND", message: "Job not found" },
				}),
		});
		await expect(api.prepJob("https://unknown.com", "unknown")).rejects.toThrow(
			"NOT_FOUND",
		);
	});

	it("throws on network failure", async () => {
		global.fetch = vi.fn().mockRejectedValue(new Error("Failed to fetch"));
		await expect(api.prepJob("https://test.com", "greenhouse")).rejects.toThrow(
			"Failed to fetch",
		);
	});
});
