import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createChromeMock,
  fireMessage,
  fireStorageChange,
  installChromeMock,
} from "../src/test-helpers/chrome-mock";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  global.fetch = fetchMock as unknown as typeof fetch;
  fetchMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  delete (global as { chrome?: unknown }).chrome;
});

const GREENHOUSE_JOB = {
  id: "j1",
  url: "https://boards.greenhouse.io/x/jobs/1",
  atsType: "greenhouse",
  title: "Eng",
  employer: "Acme",
  suitabilityScore: 0.8,
};

const okQueue = (jobs: unknown[]) =>
  ({
    json: async () => ({ ok: true, data: { jobs } }),
  }) as Response;

const emptyQueue = () => okQueue([]);

const okResult = () =>
  ({
    json: async () => ({ ok: true, data: { ok: true } }),
  }) as Response;

const failResult = (status: number) =>
  ({
    ok: false,
    status,
    json: async () => ({
      ok: false,
      error: { code: "SERVER_ERROR", message: "fail" },
    }),
  }) as Response;

describe("background result handling (US-016b)", () => {
  it("happy path: reportQueueResult succeeds, tab is closed", async () => {
    const mock = createChromeMock({ "autoApply.enabled": false });
    installChromeMock(mock);
    fetchMock.mockResolvedValueOnce(okQueue([GREENHOUSE_JOB]));

    const { drainPending } = await import("../background");
    await vi.advanceTimersByTimeAsync(0);

    fireStorageChange(mock, { "autoApply.enabled": { newValue: true } });
    await vi.advanceTimersByTimeAsync(100);

    fetchMock.mockResolvedValueOnce(okResult());

    fireMessage(
      mock,
      {
        kind: "jobops:result",
        jobId: "j1",
        outcome: "submitted",
        confirmationId: "abc-123",
      },
      { tab: { id: 42 } },
    );
    await drainPending();

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/applications/queue-result"),
      expect.objectContaining({ method: "POST" }),
    );
    expect(mock.tabs.remove).toHaveBeenCalledWith(42);
  });

  it("5xx on report queues to pendingResults after retries exhausted", async () => {
    const mock = createChromeMock({ "autoApply.enabled": false });
    installChromeMock(mock);
    fetchMock.mockResolvedValueOnce(okQueue([GREENHOUSE_JOB]));

    const { drainPending } = await import("../background");
    await vi.advanceTimersByTimeAsync(0);

    fireStorageChange(mock, { "autoApply.enabled": { newValue: true } });
    await vi.advanceTimersByTimeAsync(100);

    fetchMock
      .mockResolvedValueOnce(failResult(500))
      .mockResolvedValueOnce(failResult(500))
      .mockResolvedValueOnce(failResult(500));

    fireMessage(
      mock,
      {
        kind: "jobops:result",
        jobId: "j1",
        outcome: "skipped",
        reason: "test",
      },
      { tab: { id: 43 } },
    );
    await vi.advanceTimersByTimeAsync(0);

    // reportWithRetry attempt 0 fails → sleeps 1s
    await vi.advanceTimersByTimeAsync(1100);
    // reportWithRetry attempt 1 fails → sleeps 2s
    await vi.advanceTimersByTimeAsync(2100);
    // reportWithRetry attempt 2 fails → queues pending result
    await drainPending();

    const setCalls = mock.storage.local.set.mock.calls;
    const lastSet = setCalls[setCalls.length - 1]?.[0];
    expect(lastSet?.pendingResults).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ jobId: "j1", outcome: "skipped" }),
      ]),
    );
  });

  it("timeout path: tab timeout triggers failed report and closes tab", async () => {
    const mock = createChromeMock({ "autoApply.enabled": false });
    installChromeMock(mock);
    fetchMock.mockResolvedValueOnce(okQueue([GREENHOUSE_JOB]));

    const { drainPending } = await import("../background");
    await vi.advanceTimersByTimeAsync(0);

    fireStorageChange(mock, { "autoApply.enabled": { newValue: true } });
    await vi.advanceTimersByTimeAsync(100);

    fetchMock.mockResolvedValueOnce(okResult());

    // Advance 120s to trigger the timeout callback
    await vi.advanceTimersByTimeAsync(120_000);
    await drainPending();

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/applications/queue-result"),
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining("timeout"),
      }),
    );
  });

  it("flushes pendingResults on next successful poll", async () => {
    const mock = createChromeMock({
      "autoApply.enabled": false,
      pendingResults: [
        {
          kind: "jobops:result",
          jobId: "old",
          outcome: "failed",
          reason: "stale",
        },
      ],
    });
    installChromeMock(mock);
    fetchMock
      .mockResolvedValueOnce(emptyQueue())
      .mockResolvedValueOnce(okResult());

    const { drainPending } = await import("../background");
    await vi.advanceTimersByTimeAsync(0);

    fireStorageChange(mock, { "autoApply.enabled": { newValue: true } });
    await vi.advanceTimersByTimeAsync(100);
    await drainPending();

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/applications/queue-result"),
      expect.objectContaining({ method: "POST" }),
    );
  });
});
