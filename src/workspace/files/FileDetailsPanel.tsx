import { useState } from "react";
import type { WorkspaceCopy } from "../copy";
import type { RemoteFileEntry } from "../types";
import { displaySize, formatModifiedAt, kindLabel } from "./fileDisplay";
import { FileGlyph } from "./FileGlyph";
import type { FilesUiCopy } from "./filesUiCopy";
import { usePersonalInfoMasking } from "../../ui/PersonalInfoMasking";

export function FileDetailsPanel({
  copy,
  entry,
  locale,
  selectedCount,
  terminalAvailable,
  ui,
  onClose,
  onCopyPath,
  onDelete,
  onDownload,
  onOpenTerminal,
  onPreview,
  onRename
}: {
  copy: WorkspaceCopy;
  entry: RemoteFileEntry | null;
  locale: "en" | "zh";
  selectedCount: number;
  terminalAvailable: boolean;
  ui: FilesUiCopy;
  onClose: () => void;
  onCopyPath: (entry: RemoteFileEntry) => void;
  onDelete: (entry: RemoteFileEntry) => void;
  onDownload: (entry: RemoteFileEntry) => void;
  onOpenTerminal: (entry: RemoteFileEntry) => void;
  onPreview: (entry: RemoteFileEntry) => void;
  onRename: (entry: RemoteFileEntry) => void;
}) {
  const personalInfo = usePersonalInfoMasking();
  const [tab, setTab] = useState<"details" | "activity">("details");
  const canMutate = Boolean(entry?.writable && entry.nameEncoding === "utf8");
  const dateLocale = locale === "zh" ? "zh-CN" : "en";

  return (
    <aside aria-label={ui.details} className="workspaceFilesDetails">
      <header className="workspaceFilesDetailsHeader">
        <div className="workspaceFilesDetailsTitle">
          {entry ? <FileGlyph kind={entry.kind} /> : null}
          <strong title={entry ? personalInfo.maskText(entry.canonicalPath) : undefined}>{entry ? personalInfo.maskText(entry.name) : ui.details}</strong>
        </div>
        <button aria-label={ui.closePanel} title={ui.closePanel} type="button" onClick={onClose}>×</button>
      </header>
      <div className="workspaceFilesDetailsTabs" role="tablist">
        <button aria-selected={tab === "details"} role="tab" type="button" onClick={() => setTab("details")}>{ui.details}</button>
        <button aria-selected={tab === "activity"} role="tab" type="button" onClick={() => setTab("activity")}>{ui.activity}</button>
      </div>
      {!entry ? <div className="workspaceFilesDetailsEmpty"><FileGlyph kind="file" /><p>{ui.noSelection}</p></div> : null}
      {entry && tab === "details" ? (
        <div className="workspaceFilesDetailsBody">
          {selectedCount > 1 ? <p className="workspaceFilesSelectionNote">{selectedCount} {ui.selectedItems}</p> : null}
          <dl>
            <dt>{ui.type}</dt><dd>{kindLabel(entry, copy)}</dd>
            <dt>{ui.path}</dt><dd><code>{personalInfo.maskText(entry.canonicalPath)}</code></dd>
            <dt>{ui.size}</dt><dd>{entry.kind === "directory" ? "—" : displaySize(entry.size)}</dd>
            <dt>{ui.permissions}</dt><dd><code>{entry.permissions ?? "—"}</code></dd>
            <dt>{ui.ownerUid}</dt><dd><code>{entry.uid ?? ui.unknownOwner}</code></dd>
            <dt>{ui.ownerGid}</dt><dd><code>{entry.gid ?? ui.unknownOwner}</code></dd>
            <dt>{ui.modified}</dt><dd>{formatModifiedAt(entry.modifiedAt, dateLocale)}</dd>
            {entry.symlinkTarget ? <><dt>{copy.destination}</dt><dd><code>{personalInfo.maskText(entry.symlinkTarget)}</code></dd></> : null}
          </dl>
        </div>
      ) : null}
      {entry && tab === "activity" ? (
        <div className="workspaceFilesActivity">
          <span className="workspaceFilesActivityDot" aria-hidden="true" />
          <div><strong>{ui.modified}</strong><time>{formatModifiedAt(entry.modifiedAt, dateLocale)}</time></div>
        </div>
      ) : null}
      {entry ? (
        <footer className="workspaceFilesDetailsActions">
          <button disabled={!terminalAvailable} title={!terminalAvailable ? copy.terminalHereUnavailable : ui.openTerminal} type="button" onClick={() => onOpenTerminal(entry)}>{ui.openTerminal}</button>
          <details>
            <summary>{ui.moreActions}</summary>
            <div>
              <button type="button" onClick={() => onPreview(entry)}>{copy.preview}</button>
              <button type="button" onClick={() => onDownload(entry)}>{copy.download}</button>
              <button disabled={!canMutate} type="button" onClick={() => onRename(entry)}>{copy.rename}</button>
              <button disabled={!canMutate} type="button" onClick={() => onDelete(entry)}>{copy.delete}</button>
              <button type="button" onClick={() => onCopyPath(entry)}>{copy.copyPath}</button>
            </div>
          </details>
        </footer>
      ) : null}
    </aside>
  );
}
