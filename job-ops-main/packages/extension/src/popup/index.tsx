import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { getSettings, setSettings } from "../lib/storage";

function Popup() {
	const [serverUrl, setServerUrl] = useState("http://localhost:3005");
	const [autoFill, setAutoFill] = useState(true);

	useEffect(() => {
		getSettings().then((s) => {
			setServerUrl(s.serverUrl);
			setAutoFill(s.autoFill);
		});
	}, []);

	const save = async () => {
		await setSettings({ serverUrl, autoFill });
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
				style={{ display: "block", fontSize: "13px", marginBottom: "4px" }}
			>
				Server URL
			</label>
			<input
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

createRoot(document.getElementById("root")!).render(<Popup />);
