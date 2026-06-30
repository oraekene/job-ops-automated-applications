import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { getSettings, setSettings } from "../lib/storage";

interface QueueStatus {
  pending: number;
  submittedToday: number;
}

interface IncompleteApp {
  id: string;
  jobId: string;
  atsType: string;
  errorMessage: string | null;
  createdAt: string;
  jobTitle: string | null;
  employer: string | null;
  jobUrl: string | null;
}

async function fetchQueueStatus(
  serverUrl: string,
): Promise<{ counts: QueueStatus }> {
  const res = await fetch(`${serverUrl}/api/applications/queue/status`, {
    headers: { "Content-Type": "application/json" },
  });
  const body = await res.json();
  if (!body.ok)
    throw new Error(body.error?.message || "Request failed");
  return body.data;
}

async function fetchIncompleteApps(
  serverUrl: string,
): Promise<IncompleteApp[]> {
  try {
    const res = await fetch(`${serverUrl}/api/applications/incomplete`);
    const body = await res.json();
    if (!body.ok) return [];
    return (body.data?.applications as IncompleteApp[]) || [];
  } catch {
    return [];
  }
}

function Popup() {
  const [serverUrl, setServerUrl] = useState("http://localhost:3001");
  const [autoFill, setAutoFill] = useState(true);
  const [blockerDetection, setBlockerDetection] = useState(true);
  const [autoApply, setAutoApply] = useState(false);
  const [queueStatus, setQueueStatus] = useState<QueueStatus | null>(null);
  const [serverOnline, setServerOnline] = useState(true);
  const [incompleteApps, setIncompleteApps] = useState<IncompleteApp[]>([]);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const serverUrlRef = useRef(serverUrl);

  const loadAutoApply = useCallback(async () => {
    // Try sync storage first, fall back to local
    const sync = await getSettings();
    const syncVal = sync.autoApplyEnabled;
    if (syncVal) {
      setAutoApply(true);
      return;
    }
    const local = await new Promise<Record<string, unknown>>((resolve) =>
      chrome.storage.local.get("autoApply.enabled", resolve),
    );
    setAutoApply(Boolean(local["autoApply.enabled"]));
  }, []);

  useEffect(() => {
    getSettings().then((s) => {
      setServerUrl(s.serverUrl);
      serverUrlRef.current = s.serverUrl;
      setAutoFill(s.autoFill);
      setBlockerDetection(s.blockerDetection);
    });
    loadAutoApply();
  }, [loadAutoApply]);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetchQueueStatus(serverUrlRef.current);
      setQueueStatus({
        pending: res.counts.pending,
        submittedToday: res.counts.submittedToday,
      });
      setServerOnline(true);
    } catch {
      setServerOnline(false);
      setQueueStatus(null);
    }
  }, []);

  const fetchIncomplete = useCallback(async () => {
    const apps = await fetchIncompleteApps(serverUrlRef.current);
    setIncompleteApps(apps);
  }, []);

  useEffect(() => {
    fetchStatus();
    fetchIncomplete();
    intervalRef.current = setInterval(() => {
      fetchStatus();
      fetchIncomplete();
    }, 10_000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [fetchStatus, fetchIncomplete]);

  const save = async () => {
    serverUrlRef.current = serverUrl;
    await setSettings({ serverUrl, autoFill, blockerDetection });
  };

  const toggleAutoApply = async (checked: boolean) => {
    setAutoApply(checked);
    chrome.storage.local.set({ "autoApply.enabled": checked });
    await setSettings({ autoApplyEnabled: checked });
  };

  return (
    <div
      style={{
        width: "300px",
        padding: "16px",
        fontFamily: "-apple-system, sans-serif",
        maxHeight: "500px",
        overflowY: "auto",
      }}
    >
      <h2 style={{ fontSize: "16px", margin: "0 0 12px" }}>JobOps Copilot</h2>

      <label
        style={{
          display: "flex",
          alignItems: "center",
          gap: "8px",
          fontSize: "13px",
          marginBottom: "8px",
          padding: "8px",
          background: autoApply ? "#e8f5e9" : "#f5f5f5",
          borderRadius: "6px",
          cursor: "pointer",
        }}
      >
        <input
          type="checkbox"
          checked={autoApply}
          onChange={(e) => toggleAutoApply(e.target.checked)}
        />
        Auto-apply
      </label>

      {autoApply && (
        <div
          style={{
            fontSize: "12px",
            color: "#666",
            marginBottom: "8px",
            padding: "6px 8px",
            background: "#f5f5f5",
            borderRadius: "4px",
          }}
        >
          {serverOnline && queueStatus ? (
            <>
              Queue: {queueStatus.pending} pending ·{" "}
              {queueStatus.submittedToday} applied today
            </>
          ) : (
            <span style={{ color: "#c62828" }}>Server offline</span>
          )}
        </div>
      )}

      {autoApply && incompleteApps.length > 0 && (
        <div
          style={{
            fontSize: "12px",
            marginBottom: "8px",
            padding: "6px 8px",
            background: "#fff3e0",
            borderRadius: "4px",
            border: "1px solid #ffe0b2",
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: "4px", color: "#e65100" }}>
            Needs manual completion ({incompleteApps.length})
          </div>
          {incompleteApps.map((app) => (
            <div
              key={app.id}
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                padding: "4px 0",
                borderTop: "1px solid #ffe0b2",
                fontSize: "11px",
              }}
            >
              <div style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {app.jobTitle || "Unknown"} at {app.employer || "Unknown"}
              </div>
              {app.jobUrl && (
                <a
                  href="#"
                  onClick={(e) => {
                    e.preventDefault();
                    chrome.tabs.create({ url: app.jobUrl! });
                  }}
                  style={{ color: "#1565c0", textDecoration: "none", marginLeft: "8px", flexShrink: 0 }}
                >
                  Open
                </a>
              )}
            </div>
          ))}
        </div>
      )}

      <label
        htmlFor="server-url"
        style={{ display: "block", fontSize: "13px", marginBottom: "4px" }}
      >
        Server URL
      </label>
      <input
        id="server-url"
        value={serverUrl}
        onChange={(e) => setServerUrl(e.target.value)}
        style={{
          width: "100%",
          padding: "6px",
          marginBottom: "12px",
          border: "1px solid #ddd",
          borderRadius: "6px",
          fontSize: "13px",
          boxSizing: "border-box",
        }}
      />
      <label
        style={{
          display: "flex",
          alignItems: "center",
          gap: "8px",
          fontSize: "13px",
          marginBottom: "12px",
        }}
      >
        <input
          type="checkbox"
          checked={autoFill}
          onChange={(e) => setAutoFill(e.target.checked)}
        />
        Auto-fill on page load
      </label>
      <label
        style={{
          display: "flex",
          alignItems: "center",
          gap: "8px",
          fontSize: "13px",
          marginBottom: blockerDetection ? "12px" : "4px",
        }}
      >
        <input
          type="checkbox"
          checked={blockerDetection}
          onChange={(e) => setBlockerDetection(e.target.checked)}
        />
        Block CAPTCHA/MFA detection
      </label>
      {!blockerDetection && (
        <div
          style={{
            fontSize: "11px",
            color: "#999",
            marginBottom: "12px",
            paddingLeft: "24px",
          }}
        >
          Fill proceeds even when CAPTCHA or MFA is detected
        </div>
      )}
      <button
        type="button"
        onClick={save}
        style={{
          width: "100%",
          padding: "8px",
          background: "#1976d2",
          color: "#fff",
          border: "none",
          borderRadius: "6px",
          cursor: "pointer",
          fontWeight: 600,
        }}
      >
        Save
      </button>
    </div>
  );
}

const rootEl = document.getElementById("root");
if (rootEl) {
  createRoot(rootEl).render(<Popup />);
}
