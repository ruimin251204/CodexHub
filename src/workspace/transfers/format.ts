import type { WorkspaceTransfer } from "../types";

export function formatBytes(value: string | null) {
  if (value === null) return "—";
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return value;
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let scaled = numeric;
  let unit = 0;
  while (Math.abs(scaled) >= 1024 && unit < units.length - 1) {
    scaled /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${scaled} ${units[unit]}` : `${scaled.toFixed(Math.abs(scaled) >= 10 ? 1 : 2)} ${units[unit]}`;
}

export function progressValue(transfer: WorkspaceTransfer) {
  if (!transfer.total) return null;
  const bytes = Number(transfer.bytes);
  const total = Number(transfer.total);
  if (!Number.isFinite(bytes) || !Number.isFinite(total) || total <= 0) return null;
  return Math.max(0, Math.min(100, (bytes / total) * 100));
}

export function formatDateTime(value: string, locale: "en" | "zh") {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "—";
  return new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en-US", {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

export function isToday(value: string) {
  const date = new Date(value);
  const today = new Date();
  return !Number.isNaN(date.valueOf())
    && date.getFullYear() === today.getFullYear()
    && date.getMonth() === today.getMonth()
    && date.getDate() === today.getDate();
}
