import { vi } from "vitest";

export interface ChromeMock {
  tabs: {
    create: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
    captureVisibleTab: ReturnType<typeof vi.fn>;
    onUpdated: {
      addListener: ReturnType<typeof vi.fn>;
    };
  };
  scripting: {
    executeScript: ReturnType<typeof vi.fn>;
  };
  alarms: {
    create: ReturnType<typeof vi.fn>;
    clear: ReturnType<typeof vi.fn>;
    onAlarm: {
      addListener: ReturnType<typeof vi.fn>;
    };
  };
  storage: {
    local: {
      get: ReturnType<typeof vi.fn>;
      set: ReturnType<typeof vi.fn>;
    };
    onChanged: {
      addListener: ReturnType<typeof vi.fn>;
    };
  };
  runtime: {
    onMessage: {
      addListener: ReturnType<typeof vi.fn>;
    };
    onInstalled: {
      addListener: ReturnType<typeof vi.fn>;
    };
  };
  // Internal: bookkeeping for emitting events from tests
  _emitters: {
    alarm: Array<(alarm: { name: string }) => void>;
    storageChange: Array<
      (
        changes: Record<string, chrome.storage.StorageChange>,
        area: string,
      ) => void
    >;
    tabUpdated: Array<
      (
        tabId: number,
        info: chrome.tabs.TabChangeInfo,
        tab: chrome.tabs.Tab,
      ) => void
    >;
  };
}

export function createChromeMock(
  initialStorage: Record<string, unknown> = {},
): ChromeMock {
  const alarmListeners: Array<(alarm: { name: string }) => void> = [];
  const storageChangeListeners: Array<
    (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string,
    ) => void
  > = [];
  const tabUpdatedListeners: Array<
    (
      tabId: number,
      info: chrome.tabs.TabChangeInfo,
      tab: chrome.tabs.Tab,
    ) => void
  > = [];

  const storageState: Record<string, unknown> = { ...initialStorage };

  const storageGet = vi.fn(
    (
      key: string | string[] | Record<string, unknown> | null,
      callback?: (data: Record<string, unknown>) => void,
    ) => {
      const keys = Array.isArray(key)
        ? key
        : typeof key === "string"
          ? [key]
          : key
            ? Object.keys(key)
            : null;
      const result: Record<string, unknown> = {};
      if (keys === null) {
        Object.assign(result, storageState);
      } else {
        for (const k of keys) {
          if (k in storageState) result[k] = storageState[k];
        }
      }
      if (callback) callback(result);
      return Promise.resolve(result);
    },
  );

  const storageSet = vi.fn(
    (data: Record<string, unknown>, callback?: () => void) => {
      const changes: Record<string, chrome.storage.StorageChange> = {};
      for (const [k, v] of Object.entries(data)) {
        changes[k] = { oldValue: storageState[k], newValue: v };
        storageState[k] = v;
      }
      for (const listener of storageChangeListeners) {
        listener(changes, "local");
      }
      if (callback) callback();
      return Promise.resolve();
    },
  );

  const mock: ChromeMock = {
    tabs: {
      create: vi.fn().mockResolvedValue({ id: 42 }),
      remove: vi.fn().mockResolvedValue(undefined),
      captureVisibleTab: vi.fn(
        (
          _tabId: number,
          _options: unknown,
          callback?: (dataUrl: string) => void,
        ) => {
          if (callback) callback("data:image/png;base64,abc");
          return Promise.resolve("data:image/png;base64,abc");
        },
      ),
      onUpdated: { addListener: vi.fn((fn) => tabUpdatedListeners.push(fn)) },
    },
    scripting: { executeScript: vi.fn().mockResolvedValue(undefined) },
    alarms: {
      create: vi.fn(),
      clear: vi.fn().mockResolvedValue(true),
      onAlarm: { addListener: vi.fn((fn) => alarmListeners.push(fn)) },
    },
    storage: {
      local: { get: storageGet, set: storageSet },
      onChanged: {
        addListener: vi.fn((fn) => storageChangeListeners.push(fn)),
      },
    },
    runtime: {
      onMessage: { addListener: vi.fn() },
      onInstalled: { addListener: vi.fn() },
    },
    _emitters: {
      alarm: alarmListeners,
      storageChange: storageChangeListeners,
      tabUpdated: tabUpdatedListeners,
    },
  };

  return mock;
}

export function installChromeMock(
  mock: ChromeMock,
  initialStorage: Record<string, unknown> = {},
): void {
  (globalThis as unknown as { chrome: ChromeMock }).chrome = mock;
  if (Object.keys(initialStorage).length > 0) {
    mock.storage.local.set(initialStorage);
  }
}

export function fireStorageChange(
  mock: ChromeMock,
  changes: Record<string, chrome.storage.StorageChange>,
  area: string = "local",
): void {
  for (const listener of mock._emitters.storageChange) {
    listener(changes, area);
  }
}

export function fireAlarm(mock: ChromeMock, name: string): void {
  for (const listener of mock._emitters.alarm) {
    listener({ name });
  }
}

export function fireTabUpdated(
  mock: ChromeMock,
  tabId: number,
  info: chrome.tabs.TabChangeInfo,
  tab: chrome.tabs.Tab,
): void {
  for (const listener of mock._emitters.tabUpdated) {
    listener(tabId, info, tab);
  }
}

export function fireMessage(
  mock: ChromeMock,
  message: unknown,
  sender: { tab?: { id?: number } } = {},
): void {
  const addListenerMock = mock.runtime.onMessage.addListener;
  const calls = addListenerMock.mock.calls as Array<
    [(msg: unknown, sender: unknown) => void]
  >;
  for (const call of calls) {
    call[0](message, sender);
  }
}
