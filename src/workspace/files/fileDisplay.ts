import type { RemoteFileEntry } from "../types";
import type { WorkspaceCopy } from "../copy";

export function parentPath(path: string) {
  if (path === "/" || /^[A-Za-z]:\/?$/.test(path)) return path.endsWith("/") ? path : `${path}/`;
  const normalized = path.replace(/\/+$/, "");
  const separator = normalized.lastIndexOf("/");
  if (separator === 2 && /^[A-Za-z]:/.test(normalized)) return `${normalized.slice(0, 2)}/`;
  return separator <= 0 ? "/" : normalized.slice(0, separator);
}

export function childPath(parent: string, name: string) {
  return parent === "/" ? `/${name}` : `${parent.replace(/\/+$/, "")}/${name}`;
}

export function displaySize(value: string) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes)) return value;
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let result = bytes;
  let unit = 0;
  while (result >= 1024 && unit < units.length - 1) {
    result /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${result} ${units[unit]}` : `${result.toFixed(result >= 10 ? 1 : 2)} ${units[unit]}`;
}

export function formatModifiedAt(value: string | null, locale?: string) {
  if (!value) return "—";
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime()) ? "—" : timestamp.toLocaleString(locale);
}

export function kindLabel(entry: RemoteFileEntry, copy: WorkspaceCopy) {
  if (entry.kind === "directory") return copy.directory;
  if (entry.kind === "file") return copy.file;
  if (entry.kind === "symlink") return copy.symlink;
  return copy.other;
}
