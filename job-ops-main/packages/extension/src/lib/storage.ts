export interface ExtensionSettings {
  serverUrl: string;
  autoFill: boolean;
  autoApplyEnabled: boolean;
}

export async function getSettings(): Promise<ExtensionSettings> {
  return new Promise((resolve) => {
    chrome.storage.sync.get(
      { serverUrl: "http://localhost:3005", autoFill: true, autoApplyEnabled: false },
      (items) => {
        resolve(items as ExtensionSettings);
      },
    );
  });
}

export async function setSettings(
  settings: Partial<ExtensionSettings>,
): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.sync.set(settings, resolve);
  });
}
