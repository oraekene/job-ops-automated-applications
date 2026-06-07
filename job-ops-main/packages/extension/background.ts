import { detectAtsByUrl } from "./src/drivers/ats-detector";
import {
  JobOpsApi,
  type JobopsResult,
  type QueueItem,
} from "./src/lib/jobops-api";

const ALARM_NAME = "jobops-poll";
const POLL_PERIOD_MINUTES = 0.5;
const BACKOFF_DELAYS_S = [30, 60, 120, 240, 300];
const QUEUE_LIMIT = 10;
const MAX_CONCURRENT_TABS = 3;
const API_BASE = "http://localhost:3005";
const TOGGLE_KEY = "autoApply.enabled";
const TAB_TIMEOUT_MS = 120_000;
const REPORT_RETRY_DELAYS_MS = [1000, 2000, 4000];
const PENDING_RESULTS_KEY = "pendingResults";

type State = "idle" | "polling" | "processing" | "backoff";

let state: State = "idle";
let backoffStep = 0;
let aborted = false;
const dispatching: Map<string, number> = new Map();
const tabTimeouts: Map<string, ReturnType<typeof setTimeout>> = new Map();
const api: JobOpsApi = new JobOpsApi(API_BASE);
const pendingWork: Set<Promise<void>> = new Set();

function trackWork(p: Promise<void>): void {
  pendingWork.add(p);
  p.finally(() => pendingWork.delete(p));
}

export async function drainPending(): Promise<void> {
  while (pendingWork.size > 0) {
    await Promise.all([...pendingWork]);
  }
}

const chromeAlarms = chrome.alarms;
const chromeStorage = chrome.storage;
const chromeTabs = chrome.tabs;
const chromeScripting = chrome.scripting;

function isToggleOn(): Promise<boolean> {
  return new Promise((resolve) => {
    chromeStorage.local.get(TOGGLE_KEY, (data) => {
      resolve(Boolean((data as Record<string, unknown>)?.[TOGGLE_KEY]));
    });
  });
}

async function dispatchJob(job: QueueItem): Promise<void> {
  if (aborted) return;

  const atsType = detectAtsByUrl(job.url);
  if (atsType === "unknown") {
    console.warn("JobOps: skipping unknown ATS", job.url);
    return;
  }

  if (dispatching.size >= MAX_CONCURRENT_TABS) {
    return;
  }

  const url = new URL(job.url);
  url.searchParams.set("jobId", job.id);

  const tab = await chromeTabs.create({ url: url.toString(), active: false });
  if (typeof tab.id === "number") {
    dispatching.set(job.id, tab.id);

    const timeout = setTimeout(() => {
      const tabId = dispatching.get(job.id);
      if (typeof tabId === "number") {
        trackWork(
          reportWithRetry({
            kind: "jobops:result",
            jobId: job.id,
            outcome: "failed",
            reason: "timeout",
          }),
        );
        dispatching.delete(job.id);
        tabTimeouts.delete(job.id);
        chromeTabs.remove(tabId).catch(() => {});
      }
    }, TAB_TIMEOUT_MS);
    tabTimeouts.set(job.id, timeout);
  }
}

async function reportWithRetry(msg: JobopsResult): Promise<void> {
  for (let attempt = 0; attempt < REPORT_RETRY_DELAYS_MS.length; attempt++) {
    try {
      await api.reportQueueResult(msg);
      return;
    } catch (err) {
      const isLast = attempt === REPORT_RETRY_DELAYS_MS.length - 1;
      if (!isLast) {
        const delay = REPORT_RETRY_DELAYS_MS[attempt];
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  await queuePendingResult(msg);
}

async function queuePendingResult(msg: JobopsResult): Promise<void> {
  try {
    const result = await new Promise<Record<string, unknown>>((resolve) => {
      chromeStorage.local.get(PENDING_RESULTS_KEY, resolve);
    });
    const existing = Array.isArray(result[PENDING_RESULTS_KEY])
      ? (result[PENDING_RESULTS_KEY] as JobopsResult[])
      : [];
    existing.push(msg);
    await new Promise<void>((resolve) => {
      chromeStorage.local.set({ [PENDING_RESULTS_KEY]: existing }, resolve);
    });
  } catch (err) {
    console.warn("JobOps: failed to queue pending result", err);
  }
}

async function flushPendingResults(): Promise<void> {
  try {
    const result = await new Promise<Record<string, unknown>>((resolve) => {
      chromeStorage.local.get(PENDING_RESULTS_KEY, resolve);
    });
    const pending = Array.isArray(result[PENDING_RESULTS_KEY])
      ? (result[PENDING_RESULTS_KEY] as JobopsResult[])
      : [];
    if (pending.length === 0) return;

    const remaining: JobopsResult[] = [];
    for (const msg of pending) {
      try {
        await api.reportQueueResult(msg);
      } catch {
        remaining.push(msg);
      }
    }

    await new Promise<void>((resolve) => {
      chromeStorage.local.set(
        { [PENDING_RESULTS_KEY]: remaining },
        resolve,
      );
    });
  } catch (err) {
    console.warn("JobOps: failed to flush pending results", err);
  }
}

async function pollAndDispatch(): Promise<void> {
  if (aborted || state !== "idle") return;

  state = "polling";
  let jobs: QueueItem[] = [];
  let success = false;
  try {
    const res = await api.getQueue(QUEUE_LIMIT);
    if (aborted) {
      state = "idle";
      return;
    }
    jobs = res.jobs;
    success = true;
  } catch {
    state = "backoff";
    const delay =
      BACKOFF_DELAYS_S[Math.min(backoffStep, BACKOFF_DELAYS_S.length - 1)];
    backoffStep++;
    chromeAlarms.create(ALARM_NAME, { delayInMinutes: delay / 60 });
    return;
  }

  if (success) {
    await flushPendingResults();
  }

  if (success && jobs.length > 0) {
    state = "processing";
    for (const job of jobs) {
      if (aborted) break;
      if (dispatching.size >= MAX_CONCURRENT_TABS) break;
      await dispatchJob(job);
    }
  }

  if (aborted) {
    state = "idle";
    return;
  }

  backoffStep = 0;
  state = "idle";
  chromeAlarms.create(ALARM_NAME, { periodInMinutes: POLL_PERIOD_MINUTES });
}

chromeTabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (info.status !== "complete" || !tab.url) return;
  const atsType = detectAtsByUrl(tab.url);
  if (atsType === "unknown") return;
  await chromeScripting.executeScript({
    target: { tabId },
    files: ["content-script.js"],
  });
});

chromeAlarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    void pollAndDispatch();
  }
});

chromeStorage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  const change = changes[TOGGLE_KEY];
  if (!change) return;
  const newValue = Boolean(change.newValue);
  if (newValue) {
    aborted = false;
    backoffStep = 0;
    chromeAlarms.create(ALARM_NAME, { periodInMinutes: POLL_PERIOD_MINUTES });
    void pollAndDispatch();
  } else {
    aborted = true;
    void chromeAlarms.clear(ALARM_NAME);
    state = "idle";
  }
});

chrome.runtime.onMessage.addListener(
  (message: JobopsResult, sender): true | undefined => {
    if (message.kind !== "jobops:result") return;

    const tabId = sender.tab?.id;
    const jobId = message.jobId;

    const timeout = tabTimeouts.get(jobId);
    if (timeout) {
      clearTimeout(timeout);
      tabTimeouts.delete(jobId);
    }

    if (message.outcome === "submitted" && typeof tabId === "number") {
      chromeTabs.captureVisibleTab(
        tabId,
        { format: "png" },
        (dataUrl) => {
          const screenshotBase64 = dataUrl
            ? dataUrl.split(",")[1]
            : undefined;
          const reportMsg: JobopsResult = {
            ...message,
            screenshotBase64: screenshotBase64 ?? undefined,
          };
          trackWork(reportWithRetry(reportMsg));
        },
      );
    } else {
      trackWork(reportWithRetry(message));
    }

    if (typeof tabId === "number") {
      dispatching.delete(jobId);
      chromeTabs.remove(tabId).catch(() => {});
    }

    return true;
  },
);

void isToggleOn()
  .then((on) => {
    if (on) {
      chromeAlarms.create(ALARM_NAME, { periodInMinutes: POLL_PERIOD_MINUTES });
    }
  })
  .catch(() => {
    // ignore — service worker is the source of truth
  });
