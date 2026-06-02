interface ApprovalDialogProps {
  fields: Record<string, string>;
  missingFields: string[];
  jobTitle: string;
}

export function ApprovalDialog({
  fields,
  missingFields,
  jobTitle,
}: ApprovalDialogProps) {
  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 2147483646,
        background: "rgba(0,0,0,0.5)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      }}
    >
      <div
        style={{
          background: "#fff",
          borderRadius: "12px",
          padding: "24px",
          width: "480px",
          maxHeight: "80vh",
          overflow: "auto",
        }}
      >
        <h2 style={{ margin: "0 0 4px", fontSize: "18px", fontWeight: 600 }}>
          Review Application
        </h2>
        <p style={{ margin: "0 0 16px", color: "#666", fontSize: "14px" }}>
          {jobTitle}
        </p>

        <div style={{ marginBottom: "16px" }}>
          <h3 style={{ fontSize: "14px", fontWeight: 600, margin: "0 0 8px" }}>
            Filled Fields
          </h3>
          {Object.entries(fields).map(([key, value]) => (
            <div
              key={key}
              style={{
                display: "flex",
                justifyContent: "space-between",
                padding: "6px 0",
                borderBottom: "1px solid #eee",
              }}
            >
              <span
                style={{
                  fontSize: "13px",
                  color: "#666",
                  textTransform: "capitalize",
                }}
              >
                {key.replace(/_/g, " ")}
              </span>
              <span style={{ fontSize: "13px", fontWeight: 500 }}>{value}</span>
            </div>
          ))}
        </div>

        {missingFields.length > 0 && (
          <div
            style={{
              marginBottom: "16px",
              padding: "8px",
              background: "#ffebee",
              borderRadius: "8px",
            }}
          >
            <span
              style={{ color: "#c62828", fontSize: "13px", fontWeight: 600 }}
            >
              Missing fields:
            </span>
            {missingFields.map((f) => (
              <div key={f} style={{ fontSize: "12px", color: "#c62828" }}>
                {f}
              </div>
            ))}
          </div>
        )}

        <div style={{ fontSize: "12px", color: "#999", marginBottom: "16px" }}>
          Click the ATS submit button on the page to send your application —
          JobOps does not auto-submit.
        </div>
      </div>
    </div>
  );
}
