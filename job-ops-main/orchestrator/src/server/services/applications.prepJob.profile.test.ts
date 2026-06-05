import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./profile", () => ({
  getProfile: vi.fn(),
}));

import { getProfile } from "./profile";

describe.sequential("applicationService.prepJob profile mapping (US-003)", () => {
  let tempDir: string;
  let jobsRepo: any;
  let applicationService: any;

  beforeEach(async () => {
    vi.resetModules();
    tempDir = await mkdtemp(join(tmpdir(), "job-ops-prepjob-profile-test-"));
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

  it("maps a complete RxResume profile into the 6 prep profile fields", async () => {
    const url = "https://boards.greenhouse.io/acme/jobs/12345";
    await jobsRepo.createJob({
      source: "greenhouse",
      sourceJobId: "12345",
      title: "Senior Engineer",
      employer: "Acme",
      jobUrl: url,
    });

    vi.mocked(getProfile).mockResolvedValue({
      basics: {
        name: "Ifeanyi Orae",
        email: "ifeanyi@example.com",
        phone: "+44 7000 000000",
        profiles: [
          {
            network: "GitHub",
            username: "oraekene",
            url: "https://github.com/oraekene",
          },
          {
            network: "LinkedIn",
            username: "oraekene",
            url: "https://www.linkedin.com/in/oraekene",
          },
        ],
      },
      sections: {
        experience: {
          items: [
            {
              id: "1",
              company: "Acme Corp",
              position: "Engineer",
              location: "London",
              date: "2024-01",
              summary: "",
              visible: true,
            },
          ],
        },
      },
    } as any);

    const result = await applicationService.prepJob(url, "greenhouse");

    expect(result.exists).toBe(true);
    expect(result.profile).toEqual({
      first_name: "Ifeanyi",
      last_name: "Orae",
      email: "ifeanyi@example.com",
      phone: "+447000000000",
      linkedin_url: "https://www.linkedin.com/in/oraekene",
      current_company: "Acme Corp",
    });
  });

  it("returns profile:null when getProfile throws (onboarding not complete)", async () => {
    const url = "https://boards.greenhouse.io/acme/jobs/12345";
    await jobsRepo.createJob({
      source: "greenhouse",
      sourceJobId: "12345",
      title: "Senior Engineer",
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

  it("returns profile:null when the resume is missing the required name+email fields", async () => {
    const url = "https://boards.greenhouse.io/acme/jobs/12345";
    await jobsRepo.createJob({
      source: "greenhouse",
      sourceJobId: "12345",
      title: "Senior Engineer",
      employer: "Acme",
      jobUrl: url,
    });

    vi.mocked(getProfile).mockResolvedValue({
      basics: {
        name: "  ",
        email: "",
        phone: "+44 7000 000000",
      },
      sections: { experience: { items: [] } },
    } as any);

    const result = await applicationService.prepJob(url, "greenhouse");

    expect(result.exists).toBe(true);
    expect(result.profile).toBeNull();
  });

  it("omits the profile key entirely when the URL is not in the jobs table", async () => {
    vi.mocked(getProfile).mockResolvedValue({
      basics: { name: "Ifeanyi Orae", email: "ifeanyi@example.com" },
    } as any);

    const result = await applicationService.prepJob(
      "https://example.com/missing",
      "greenhouse",
    );

    expect(result.exists).toBe(false);
    expect(result.profile).toBeUndefined();
  });
});
