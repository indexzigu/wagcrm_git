export function DataSourceBanner({
  message,
  tone = "warning",
}: {
  message: string;
  tone?: "warning" | "success" | "error";
}) {
  const toneClassName =
    tone === "success"
      ? "border-status-success/30 bg-status-success-bg text-status-success"
      : tone === "error"
        ? "border-status-urgent/30 bg-status-urgent-bg text-status-urgent-text"
        : "border-status-caution/30 bg-status-caution-bg text-status-caution-text";

  return (
    <div className={`rounded-xl border px-4 py-3 text-sm ${toneClassName}`}>
      {message}
    </div>
  );
}
