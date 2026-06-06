import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createChromeMock,
  fireStorageChange,
  installChromeMock,
} from "../src/test-helpers/chrome-mock";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.resetModules();
  global.fetch = fetchMock as unknown as typeof fetch;
  fetchMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  delete (global as { chrome?: unknown }).chrome;
});

const greenhouseJob = (id: string, slug: string) => ({
  id,
  url: `https://boards.greenhouse.io/x/jobs/${slug}`,
  atsType: "greenhouse",
  title: `Eng ${id}`,
  employer: "Acme",
  suitabilityScore: 0.8,
});

const leverJob = (id: string, slug: string) => ({
  id,
  url: `https://jobs.lever.co/x/${slug}`,
  atsType: "lever",
  title: `Dev ${id}`,
  employer: "Beta",
  suitabilityScore: 0.9,
});

const okQueue = (jobs: unknown[]) =>
  ({
    json: async () => ({ ok: true, data: { jobs } }),
  }) as Response;

describe("background service worker (queue dispatch)", () => {
  it("opens a tab per queue item with active:false and ?jobId=… query param", async () => {
    const mock = createChromeMock({ "autoApply.enabled": false });
    installChromeMock(mock);

    const jobs = [
      greenhouseJob("j1", "1"),
      greenhouseJob("j2", "2"),
      leverJob("j3", "role"),
    ];
    fetchMock.mockResolvedValueOnce(okQueue(jobs));

    await import("../background");
    await new Promise((r) => setTimeout(r, 0));

    fireStorageChange(mock, { "autoApply.enabled": { newValue: true } });
    await new Promise((r) => setTimeout(r, 100));

    expect(mock.tabs.create).toHaveBeenCalledTimes(3);

    for (const j of jobs) {
      const expectedUrl = new URL(j.url);
      expectedUrl.searchParams.set("jobId", j.id);
      expect(mock.tabs.create).toHaveBeenCalledWith({
        url: expectedUrl.toString(),
        active: false,
      });
    }
  });

  it("skips queue items whose URL is not a known ATS (no tab opens, warning logged)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mock = createChromeMock({ "autoApply.enabled": false });
    installChromeMock(mock);

    const unknownJob = {
      id: "j1",
      url: "https://example.com/apply",
      atsType: "unknown",
      title: "Eng",
      employer: "Acme",
      suitabilityScore: 0.8,
    };
    fetchMock.mockResolvedValueOnce(okQueue([unknownJob]));

    await import("../background");
    await new Promise((r) => setTimeout(r, 0));

    fireStorageChange(mock, { "autoApply.enabled": { newValue: true } });
    await new Promise((r) => setTimeout(r, 100));

    expect(mock.tabs.create).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("unknown ATS"),
      unknownJob.url,
    );

    warnSpy.mockRestore();
  });

  it("caps concurrent open tabs at 3 (5 jobs in queue → only 3 tabs opened)", async () => {
    const mock = createChromeMock({ "autoApply.enabled": false });
    installChromeMock(mock);

    const jobs = [
      greenhouseJob("j1", "1"),
      greenhouseJob("j2", "2"),
      greenhouseJob("j3", "3"),
      greenhouseJob("j4", "4"),
      greenhouseJob("j5", "5"),
    ];
    fetchMock.mockResolvedValueOnce(okQueue(jobs));

    await import("../background");
    await new Promise((r) => setTimeout(r, 0));

    fireStorageChange(mock, { "autoApply.enabled": { newValue: true } });
    await new Promise((r) => setTimeout(r, 100));

    expect(mock.tabs.create).toHaveBeenCalledTimes(3);

    const openedUrls = mock.tabs.create.mock.calls.map(
      (call) => (call[0] as { url: string }).url,
    );
    expect(openedUrls).toEqual(
      expect.arrayContaining([
        expect.stringContaining("jobId=j1"),
        expect.stringContaining("jobId=j2"),
        expect.stringContaining("jobId=j3"),
      ]),
    );
    expect(openedUrls.find((u) => u.includes("jobId=j4"))).toBeUndefined();
    expect(openedUrls.find((u) => u.includes("jobId=j5"))).toBeUndefined();
  });
});
