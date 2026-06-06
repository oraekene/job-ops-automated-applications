import { detectAtsByUrl } from "./src/drivers/ats-detector";
import { JobOpsApi, type QueueItem } from "./src/lib/jobops-api";

const ALARM_NAME = "jobops-poll";
const POLL_PERIOD_MINUTES = 0.5;
const BACKOFF_DELAYS_S = [30, 60, 120, 240, 300];
const QUEUE_LIMIT = 10;
const API_BASE = "http://localhost:3005";
const TOGGLE_KEY = "autoApply.enabled";

type State = "idle" | "polling" | "processing" | "backoff";

let state: State = "idle";
let backoffStep = 0;
let aborted = false;
const api: JobOpsApi = new JobOpsApi(API_BASE);

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
  await chromeTabs.create({ url: job.url, active: false });
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

  if (success && jobs.length > 0) {
    state = "processing";
    for (const job of jobs) {
      if (aborted) break;
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

void isToggleOn()
  .then((on) => {
    if (on) {
      chromeAlarms.create(ALARM_NAME, { periodInMinutes: POLL_PERIOD_MINUTES });
    }
  })
  .catch(() => {
    // ignore — service worker is the source of truth
  });
