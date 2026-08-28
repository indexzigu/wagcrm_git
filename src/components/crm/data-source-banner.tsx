export function DataSourceBanner({
  message,
  tone = "warning",
}: {
  message: string;
  tone?: "warning" | "success" | "error";
}) {
  const toneClassName =
    tone === "success"
      ? "border-emerald-200 bg-emerald-50/90 text-emerald-900"
      : tone === "error"
        ? "border-rose-200 bg-rose-50/90 text-rose-900"
        : "border-amber-200 bg-amber-50/90 text-amber-900";

  return (
    <div className={`rounded-xl border px-4 py-3 text-sm ${toneClassName}`}>
      {message}
    </div>
  );
}
