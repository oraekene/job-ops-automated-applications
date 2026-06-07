import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { JobOpsApi } from "../lib/jobops-api";
import { getSettings, setSettings } from "../lib/storage";

const API_BASE = "http://localhost:3005";
const api = new JobOpsApi(API_BASE);

interface QueueStatus {
  pending: number;
  submittedToday: number;
}

function Popup() {
  const [serverUrl, setServerUrl] = useState("http://localhost:3005");
  const [autoFill, setAutoFill] = useState(true);
  const [autoApply, setAutoApply] = useState(false);
  const [queueStatus, setQueueStatus] = useState<QueueStatus | null>(null);
  const [serverOnline, setServerOnline] = useState(true);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    getSettings().then((s) => {
      setServerUrl(s.serverUrl);
      setAutoFill(s.autoFill);
    });
    chrome.storage.local.get("autoApply.enabled", (data) => {
      setAutoApply(Boolean((data as Record<string, unknown>)["autoApply.enabled"]));
    });
  }, []);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await api.getQueueStatus();
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

  useEffect(() => {
    fetchStatus();
    intervalRef.current = setInterval(fetchStatus, 10_000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [fetchStatus]);

  const save = async () => {
    await setSettings({ serverUrl, autoFill });
  };

  const toggleAutoApply = (checked: boolean) => {
    setAutoApply(checked);
    chrome.storage.local.set({ "autoApply.enabled": checked });
  };

  return (
    <div
      style={{
        width: "280px",
        padding: "16px",
        fontFamily: "-apple-system, sans-serif",
      }}
    >
      <h2 style={{ fontSize: "16px", margin: "0 0 12px" }}>JobOps Copilot</h2>

      <label
        style={{
          display: "flex",
          alignItems: "center",
          gap: "8px",
          fontSize: "13px",
          marginBottom: "12px",
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
            marginBottom: "12px",
            padding: "6px 8px",
            background: "#f5f5f5",
            borderRadius: "4px",
          }}
        >
          {serverOnline && queueStatus ? (
            <>
              Queue: {queueStatus.pending} pending · {queueStatus.submittedToday} applied today
            </>
          ) : (
            <span style={{ color: "#c62828" }}>Server offline</span>
          )}
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
