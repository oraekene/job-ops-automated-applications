import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createChromeMock,
  fireAlarm,
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

const GREENHOUSE_JOB_1 = {
  id: "j1",
  url: "https://boards.greenhouse.io/x/jobs/1",
  atsType: "greenhouse",
  title: "Eng",
  employer: "Acme",
  suitabilityScore: 0.8,
};
const LEVER_JOB_2 = {
  id: "j2",
  url: "https://jobs.lever.co/x/jobs/2",
  atsType: "lever",
  title: "Dev",
  employer: "Beta",
  suitabilityScore: 0.9,
};
const GREENHOUSE_JOB_2 = {
  id: "j2",
  url: "https://boards.greenhouse.io/x/jobs/2",
  atsType: "greenhouse",
  title: "Dev",
  employer: "Beta",
  suitabilityScore: 0.9,
};

const okQueue = (jobs: unknown[]) =>
  ({
    json: async () => ({ ok: true, data: { jobs } }),
  }) as Response;

const emptyQueue = () => okQueue([]);

const errorQueue = () =>
  ({
    json: async () => ({
      ok: false,
      error: { code: "INTERNAL", message: "boom" },
    }),
  }) as Response;

describe("background service worker (poll loop)", () => {
  it("creates the periodic alarm and opens a tab for each queued job when toggle flips on", async () => {
    const mock = createChromeMock({ "autoApply.enabled": false });
    installChromeMock(mock);

    fetchMock.mockResolvedValueOnce(okQueue([GREENHOUSE_JOB_1, LEVER_JOB_2]));

    await import("../background");
    await new Promise((r) => setTimeout(r, 0));

    fireStorageChange(mock, { "autoApply.enabled": { newValue: true } });
    await new Promise((r) => setTimeout(r, 50));

    expect(mock.alarms.create).toHaveBeenCalledWith("jobops-poll", {
      periodInMinutes: 0.5,
    });
    expect(mock.tabs.create).toHaveBeenCalledWith({
      url: GREENHOUSE_JOB_1.url,
      active: false,
    });
    expect(mock.tabs.create).toHaveBeenCalledWith({
      url: LEVER_JOB_2.url,
      active: false,
    });
  });

  it("clears the alarm and stops polling when toggle flips off", async () => {
    const mock = createChromeMock({ "autoApply.enabled": true });
    installChromeMock(mock);

    fetchMock.mockResolvedValue(emptyQueue());

    await import("../background");
    await new Promise((r) => setTimeout(r, 0));

    fireStorageChange(mock, { "autoApply.enabled": { newValue: false } });
    await new Promise((r) => setTimeout(r, 50));

    expect(mock.alarms.clear).toHaveBeenCalledWith("jobops-poll");

    mock.tabs.create.mockClear();
    fetchMock.mockClear();
    fireAlarm(mock, "jobops-poll");
    await new Promise((r) => setTimeout(r, 50));

    expect(mock.tabs.create).not.toHaveBeenCalled();
  });

  it("enters backoff on 5xx with a 30s one-shot alarm and resumes the periodic alarm on next success", async () => {
    const mock = createChromeMock({ "autoApply.enabled": false });
    installChromeMock(mock);

    fetchMock.mockResolvedValueOnce(errorQueue());
    fetchMock.mockResolvedValueOnce(emptyQueue());

    await import("../background");
    await new Promise((r) => setTimeout(r, 0));

    fireStorageChange(mock, { "autoApply.enabled": { newValue: true } });
    await new Promise((r) => setTimeout(r, 50));

    expect(mock.alarms.create).toHaveBeenCalledWith("jobops-poll", {
      delayInMinutes: 30 / 60,
    });

    fireAlarm(mock, "jobops-poll");
    await new Promise((r) => setTimeout(r, 50));

    expect(mock.alarms.create).toHaveBeenCalledWith("jobops-poll", {
      periodInMinutes: 0.5,
    });
  });

  it("does not open additional tabs when toggle flips off mid-poll", async () => {
    const mock = createChromeMock({ "autoApply.enabled": false });
    installChromeMock(mock);

    fetchMock.mockResolvedValue(okQueue([GREENHOUSE_JOB_1, GREENHOUSE_JOB_2]));

    const realCreate = mock.tabs.create;
    mock.tabs.create = vi
      .fn()
      .mockImplementationOnce(async () => {
        mock.storage.local.set({ "autoApply.enabled": false });
        return { id: 1 };
      })
      .mockImplementation(async () => {
        realCreate();
        return { id: 2 };
      });

    await import("../background");
    await new Promise((r) => setTimeout(r, 0));

    fireStorageChange(mock, { "autoApply.enabled": { newValue: true } });
    await new Promise((r) => setTimeout(r, 100));

    expect(mock.tabs.create).toHaveBeenCalledTimes(1);
    expect(mock.tabs.create).toHaveBeenCalledWith({
      url: GREENHOUSE_JOB_1.url,
      active: false,
    });
  });
});
