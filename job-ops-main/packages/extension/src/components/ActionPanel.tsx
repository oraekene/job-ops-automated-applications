import React from "react";

interface ActionPanelProps {
	status: "idle" | "checking" | "ready" | "filling" | "review" | "done";
	jobTitle?: string;
	employer?: string;
	fitScore?: number;
	filledFields: number;
	totalFields: number;
	onFill: () => void;
	error?: string;
}

const STATUS_MESSAGES: Record<string, string> = {
	idle: "Ready",
	checking: "Checking JobOps...",
	ready: "Ready to fill",
	filling: "Filling application...",
	review: "Review before submit",
	done: "Application filled ✓",
};

export function ActionPanel({
	status,
	jobTitle,
	employer,
	fitScore,
	filledFields,
	totalFields,
	onFill,
	error,
}: ActionPanelProps) {
	return (
		<div
			style={{
				position: "fixed",
				bottom: "20px",
				right: "20px",
				zIndex: 2147483647,
				width: "320px",
				background: "#fff",
				borderRadius: "12px",
				boxShadow: "0 4px 24px rgba(0,0,0,0.15)",
				padding: "16px",
				fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
				fontSize: "14px",
				color: "#1a1a1a",
			}}
		>
			<div
				style={{
					display: "flex",
					alignItems: "center",
					gap: "8px",
					marginBottom: "12px",
				}}
			>
				<span style={{ fontWeight: 600, fontSize: "16px" }}>
					JobOps Copilot
				</span>
				<span
					style={{
						marginLeft: "auto",
						padding: "2px 8px",
						borderRadius: "20px",
						fontSize: "12px",
						background:
							status === "done"
								? "#e6f7e6"
								: status === "review"
									? "#fff3e0"
									: "#f0f0f0",
						color:
							status === "done"
								? "#2e7d32"
								: status === "review"
									? "#e65100"
									: "#666",
					}}
				>
					{STATUS_MESSAGES[status]}
				</span>
			</div>

			{jobTitle && (
				<div style={{ marginBottom: "4px", fontWeight: 500 }}>{jobTitle}</div>
			)}
			{employer && (
				<div style={{ marginBottom: "8px", color: "#666", fontSize: "13px" }}>
					{employer}
				</div>
			)}

			{fitScore !== undefined && (
				<div style={{ marginBottom: "8px" }}>
					<span style={{ fontSize: "13px", color: "#666" }}>Fit Score: </span>
					<span
						style={{
							fontWeight: 600,
							color:
								fitScore >= 70
									? "#2e7d32"
									: fitScore >= 40
										? "#e65100"
										: "#c62828",
						}}
					>
						{fitScore}/100
					</span>
				</div>
			)}

			{status === "ready" && (
				<button
					onClick={onFill}
					style={{
						width: "100%",
						padding: "10px",
						background: "#1976d2",
						color: "#fff",
						border: "none",
						borderRadius: "8px",
						cursor: "pointer",
						fontWeight: 600,
					}}
				>
					Fill Application
				</button>
			)}

			{status === "filling" && (
				<div style={{ textAlign: "center", color: "#666", padding: "8px" }}>
					Filled {filledFields} of {totalFields} fields...
				</div>
			)}

			{status === "review" && (
				<div style={{ marginBottom: "8px", fontSize: "13px", color: "#666" }}>
					{filledFields}/{totalFields} fields filled
				</div>
			)}

			{status === "done" && (
				<div
					style={{
						textAlign: "center",
						padding: "8px",
						color: "#2e7d32",
						fontWeight: 500,
					}}
				>
					✓ All fields filled — please review and submit manually
				</div>
			)}

			{error && (
				<div
					style={{
						marginTop: "8px",
						padding: "8px",
						background: "#ffebee",
						borderRadius: "8px",
						color: "#c62828",
						fontSize: "13px",
					}}
				>
					{error}
				</div>
			)}
		</div>
	);
}
