import type { WorkspaceCopy } from "../copy";
import type { RemoteFileEntry, WorkspaceFileOperationKind, WorkspaceFileOperationPreview, WorkspaceFilePreview } from "../types";
import { displaySize } from "./fileDisplay";
import { usePersonalInfoMasking } from "../../ui/PersonalInfoMasking";

const SAFE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"]);

export type PendingFileOperation = {
  operation: WorkspaceFileOperationKind;
  entry: RemoteFileEntry | null;
  name: string;
  destinationPath: string | null;
};

export type FileDeleteMode = "direct" | "backup";

export function FileDeleteModeDialog({ copy, count, onCancel, onChoose }: {
  copy: WorkspaceCopy;
  count: number;
  onCancel: () => void;
  onChoose: (mode: FileDeleteMode) => void;
}) {
  if (count === 0) return null;
  return (
    <div className="workspaceInlineDialogBackdrop" role="presentation">
      <section aria-labelledby="workspace-delete-mode-title" className="workspaceInlineDialog workspaceDeleteModeDialog" role="alertdialog" aria-modal="true">
        <h3 id="workspace-delete-mode-title">{copy.deleteModeTitle}</h3>
        <p>{copy.deleteModeBody.replace("{count}", String(count))}</p>
        <div className="workspaceDeleteModeChoices">
          <button className="workspaceDangerButton" type="button" onClick={() => onChoose("direct")}>{copy.directDelete}</button>
          <button className="workspaceDangerButton" type="button" onClick={() => onChoose("backup")}>{copy.backupDelete}</button>
          <button type="button" onClick={onCancel}>{copy.cancel}</button>
        </div>
      </section>
    </div>
  );
}

export function FileDeletePreferenceDialog({ copy, mode, onCancel, onConfirm }: {
  copy: WorkspaceCopy;
  mode: FileDeleteMode | null;
  onCancel: () => void;
  onConfirm: (remember: boolean) => void;
}) {
  if (!mode) return null;
  const modeLabel = mode === "direct" ? copy.directDelete : copy.backupDelete;
  return (
    <div className="workspaceInlineDialogBackdrop" role="presentation">
      <section aria-labelledby="workspace-delete-preference-title" className="workspaceInlineDialog workspaceDeletePreferenceDialog" role="alertdialog" aria-modal="true">
        <h3 id="workspace-delete-preference-title">{copy.deletePreferenceTitle}</h3>
        <p>{copy.deletePreferenceBody.replace("{mode}", modeLabel)}</p>
        <div className="workspaceDialogActions">
          <button type="button" onClick={onCancel}>{copy.cancel}</button>
          <button type="button" onClick={() => onConfirm(false)}>{copy.askDeleteNextTime}</button>
          <button className="workspacePrimaryButton" type="button" onClick={() => onConfirm(true)}>{copy.setDeleteDefault}</button>
        </div>
      </section>
    </div>
  );
}

export function FilePreviewDialog({ copy, preview, onClose }: {
  copy: WorkspaceCopy;
  preview: WorkspaceFilePreview | null;
  onClose: () => void;
}) {
  const personalInfo = usePersonalInfoMasking();
  if (!preview) return null;
  return (
    <div className="workspaceInlineDialogBackdrop" role="presentation">
      <section aria-labelledby="workspace-preview-title" className="workspaceInlineDialog workspacePreviewDialog" role="dialog" aria-modal="true">
        <header><h3 id="workspace-preview-title">{copy.previewTitle}: {personalInfo.maskText(preview.name)}</h3><button aria-label={copy.close} type="button" onClick={onClose}>×</button></header>
        <div className="workspacePreviewBody">
          {preview.kind === "text" && preview.text !== null ? <pre>{personalInfo.maskText(preview.text)}</pre> : null}
          {preview.kind === "image" && preview.dataBase64 && preview.mimeType && SAFE_IMAGE_TYPES.has(preview.mimeType)
            ? <img alt={preview.name} src={`data:${preview.mimeType};base64,${preview.dataBase64}`} />
            : null}
          {preview.blockedReason ? <p role="alert">{copy.previewBlocked} {personalInfo.maskText(preview.blockedReason)}</p> : null}
          {preview.kind === "metadata" && !preview.blockedReason ? <p>{copy.noPreview}</p> : null}
        </div>
        <footer>{preview.mimeType ?? copy.unknown} · {displaySize(preview.size)}{preview.truncated ? " · …" : ""}</footer>
      </section>
    </div>
  );
}

export function FileEditorDialog({
  copy,
  name,
  text,
  busy,
  dirty,
  onChange,
  onCancel,
  onSave
}: {
  copy: WorkspaceCopy;
  name: string;
  text: string;
  busy: boolean;
  dirty: boolean;
  onChange: (text: string) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  return (
    <div className="workspaceInlineDialogBackdrop" role="presentation">
      <section aria-labelledby="workspace-editor-title" className="workspaceInlineDialog workspaceEditorDialog" role="dialog" aria-modal="true">
        <header><h3 id="workspace-editor-title">{copy.editFile}: {name}</h3><button aria-label={copy.close} type="button" onClick={onCancel}>×</button></header>
        <textarea aria-label={copy.editFile} autoFocus value={text} onChange={(event) => onChange(event.target.value)} />
        <footer className="workspaceDialogActions">
          <button disabled={busy} type="button" onClick={onCancel}>{copy.cancel}</button>
          <button className="workspacePrimaryButton" disabled={busy || !dirty} type="button" onClick={onSave}>{busy ? copy.busy : copy.saveFile}</button>
        </footer>
      </section>
    </div>
  );
}

export function FileOperationDialog({
  busy,
  copy,
  nameValid,
  pending,
  preview,
  onCancel,
  onConfirm,
  onNameChange,
  onPrepare
}: {
  busy: boolean;
  copy: WorkspaceCopy;
  nameValid: boolean;
  pending: PendingFileOperation | null;
  preview: WorkspaceFileOperationPreview | null;
  onCancel: () => void;
  onConfirm: () => void;
  onNameChange: (name: string) => void;
  onPrepare: () => void;
}) {
  const personalInfo = usePersonalInfoMasking();
  if (!pending) return null;
  return (
    <div className="workspaceInlineDialogBackdrop" role="presentation">
      <section aria-labelledby="workspace-operation-title" className="workspaceInlineDialog workspaceOperationDialog" role="alertdialog" aria-modal="true">
        <h3 id="workspace-operation-title">{copy.operationTitle}</h3>
        {!preview && ["rename", "copy", "create-directory"].includes(pending.operation) ? (
          <label>{pending.operation === "create-directory" ? copy.folderName : copy.destinationName}
            <input autoFocus value={pending.name} onChange={(event) => onNameChange(event.target.value)} />
            {!nameValid ? <small role="alert">{copy.invalidName}</small> : null}
          </label>
        ) : null}
        {preview ? (
          <div className="workspaceOperationPreview">
            <dl>
              <dt>{copy.host}</dt><dd>{personalInfo.maskText(preview.hostAlias)}</dd>
              {preview.sourcePath ? <><dt>{copy.source}</dt><dd>{personalInfo.maskText(preview.sourcePath)}</dd></> : null}
              {preview.targetPath ? <><dt>{copy.destination}</dt><dd>{personalInfo.maskText(preview.targetPath)}</dd></> : null}
              {preview.backupPath ? <><dt>{copy.backup}</dt><dd>{personalInfo.maskText(preview.backupPath)}</dd></> : null}
            </dl>
            <p>{personalInfo.maskText(preview.impactSummary)}</p>
            <p className="workspaceWarningText">{copy.operationExpires}</p>
          </div>
        ) : null}
        <div className="workspaceDialogActions">
          <button disabled={busy} type="button" onClick={onCancel}>{copy.cancel}</button>
          {!preview ? <button className="workspacePrimaryButton" disabled={busy || !nameValid} type="button" onClick={onPrepare}>{busy ? copy.busy : pending.operation === "copy" ? copy.copyEntry : pending.operation === "create-directory" ? copy.confirmOperation : copy.preview}</button> : null}
          {preview ? <button className="workspacePrimaryButton" disabled={busy} type="button" onClick={onConfirm}>{busy ? copy.busy : copy.confirmOperation}</button> : null}
        </div>
      </section>
    </div>
  );
}
