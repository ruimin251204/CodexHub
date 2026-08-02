import type { RemoteFileKind } from "../types";

export function FileGlyph({ kind }: { kind: RemoteFileKind }) {
  if (kind === "directory") {
    return (
      <svg aria-hidden="true" className="workspaceFileGlyph" viewBox="0 0 24 24">
        <path d="M3.5 6.75A1.75 1.75 0 0 1 5.25 5h4.2l1.7 1.8h7.6a1.75 1.75 0 0 1 1.75 1.75v8.7A1.75 1.75 0 0 1 18.75 19H5.25a1.75 1.75 0 0 1-1.75-1.75V6.75Z" />
      </svg>
    );
  }
  if (kind === "symlink") {
    return (
      <svg aria-hidden="true" className="workspaceFileGlyph" viewBox="0 0 24 24">
        <path d="M6 3.75h7l5 5v10A1.25 1.25 0 0 1 16.75 20H6a1.25 1.25 0 0 1-1.25-1.25V5A1.25 1.25 0 0 1 6 3.75Z" />
        <path d="m10 15 5-5m-3.5 0H15v3.5" />
      </svg>
    );
  }
  return (
    <svg aria-hidden="true" className="workspaceFileGlyph" viewBox="0 0 24 24">
      <path d="M6 3.75h7l5 5v10A1.25 1.25 0 0 1 16.75 20H6a1.25 1.25 0 0 1-1.25-1.25V5A1.25 1.25 0 0 1 6 3.75Z" />
      <path d="M13 3.75v5h5" />
    </svg>
  );
}
