import type { WorkspaceHost } from "./types";

/** Avoid repeating aliases when a host already uses the alias as its name. */
export function workspaceHostLabel(host: WorkspaceHost) {
  return host.name === host.hostAlias ? host.hostAlias : `${host.name} · ${host.hostAlias}`;
}
