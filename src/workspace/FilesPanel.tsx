import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import type { WorkspaceCopy } from "./copy";
import type {
  RemoteFileEntry,
  WorkspaceApi,
  WorkspaceDirectoryPage,
  WorkspaceFileOperationKind,
  WorkspaceFileOperationPreview,
  WorkspaceFileSortField,
  WorkspaceFilePreview,
  WorkspaceFilesSession,
  WorkspaceHost,
  WorkspaceRecovery,
  WorkspaceTerminalCwdEvent,
  WorkspaceTerminalSession
} from "./types";

export const WORKSPACE_FILES_LOCATION_EVENT = "codexhub:workspace-files-location";

type SortKey = WorkspaceFileSortField;
type PendingOperation = {
  operation: WorkspaceFileOperationKind;
  entry: RemoteFileEntry | null;
  name: string;
  destinationPath: string | null;
};

type FilesHostView = {
  fileSession: WorkspaceFilesSession | null;
  page: WorkspaceDirectoryPage | null;
  pathInput: string;
  history: string[];
  historyIndex: number;
  sortKey: SortKey;
  sortAscending: boolean;
  query: string;
  searchId: string | null;
  searchResults: RemoteFileEntry[] | null;
  searchScanned: number;
  searchTruncated: boolean;
  selectedRefs: Set<string>;
  focusedIndex: number;
};

const SAFE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"]);

function parentPath(path: string) {
  if (path === "/") return "/";
  const normalized = path.replace(/\/+$/, "");
  const separator = normalized.lastIndexOf("/");
  return separator <= 0 ? "/" : normalized.slice(0, separator);
}

function childPath(parent: string, name: string) {
  return parent === "/" ? `/${name}` : `${parent.replace(/\/+$/, "")}/${name}`;
}

function displaySize(value: string) {
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

export function formatModifiedAt(value: string | null) {
  if (!value) return "—";
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime()) ? "—" : timestamp.toLocaleString();
}

function kindLabel(entry: RemoteFileEntry, copy: WorkspaceCopy) {
  if (entry.kind === "directory") return copy.directory;
  if (entry.kind === "file") return copy.file;
  if (entry.kind === "symlink") return copy.symlink;
  return copy.other;
}

function iconForEntry(entry: RemoteFileEntry) {
  if (entry.kind === "directory") return "▰";
  if (entry.kind === "symlink") return "↗";
  if (entry.kind === "file") return "▤";
  return "◇";
}

export function FilesPanel({
  activeTerminal,
  api,
  copy,
  cwd,
  followCwd,
  hosts,
  isActive,
  selectedHostAlias,
  onError,
  onFollowCwdChange,
  onHostSelected,
  onOpenTerminalAt,
  onRecoveryCreated,
  onViewRecoveries,
  onTransfersQueued
}: {
  activeTerminal: WorkspaceTerminalSession | null;
  api: WorkspaceApi;
  copy: WorkspaceCopy;
  cwd: WorkspaceTerminalCwdEvent | null;
  followCwd: boolean;
  hosts: WorkspaceHost[];
  isActive: boolean;
  selectedHostAlias: string;
  onError: (error: unknown) => void;
  onFollowCwdChange: (follow: boolean) => void;
  onHostSelected: (hostAlias: string) => void;
  onOpenTerminalAt: (hostAlias: string, fileSessionId: string, path: string) => void;
  onRecoveryCreated: (recovery: WorkspaceRecovery) => void;
  onViewRecoveries: () => void;
  onTransfersQueued?: () => void;
}) {
  const [fileSession, setFileSession] = useState<WorkspaceFilesSession | null>(null);
  const [page, setPage] = useState<WorkspaceDirectoryPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [pathInput, setPathInput] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortAscending, setSortAscending] = useState(true);
  const [query, setQuery] = useState("");
  const [searchId, setSearchId] = useState<string | null>(null);
  const [searchResults, setSearchResults] = useState<RemoteFileEntry[] | null>(null);
  const [searchScanned, setSearchScanned] = useState(0);
  const [searchTruncated, setSearchTruncated] = useState(false);
  const [selectedRefs, setSelectedRefs] = useState<Set<string>>(() => new Set());
  const [focusedIndex, setFocusedIndex] = useState(0);
  const [preview, setPreview] = useState<WorkspaceFilePreview | null>(null);
  const [contextMenu, setContextMenu] = useState<{ entry: RemoteFileEntry; x: number; y: number } | null>(null);
  const [pendingOperation, setPendingOperation] = useState<PendingOperation | null>(null);
  const [operationPreview, setOperationPreview] = useState<WorkspaceFileOperationPreview | null>(null);
  const [operationBusy, setOperationBusy] = useState(false);
  const [filesError, setFilesError] = useState(false);
  const [createdRecovery, setCreatedRecovery] = useState<WorkspaceRecovery | null>(null);
  const [connectionAttempt, setConnectionAttempt] = useState(0);
  const locationRef = useRef<HTMLInputElement>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const requestSequence = useRef(0);
  const historyIndexRef = useRef(-1);
  const pageSortSignatureRef = useRef("");
  const sortRef = useRef({ key: sortKey, ascending: sortAscending });
  const hostViewsRef = useRef(new Map<string, FilesHostView>());
  const activeHostRef = useRef("");
  const currentViewRef = useRef<FilesHostView | null>(null);

  historyIndexRef.current = historyIndex;
  sortRef.current = { key: sortKey, ascending: sortAscending };
  currentViewRef.current = {
    fileSession,
    page,
    pathInput,
    history,
    historyIndex,
    sortKey,
    sortAscending,
    query,
    searchId,
    searchResults,
    searchScanned,
    searchTruncated,
    selectedRefs,
    focusedIndex
  };

  const restoreHostView = useCallback((view: FilesHostView | null) => {
    setFileSession(view?.fileSession ?? null);
    setPage(view?.page ?? null);
    setPathInput(view?.pathInput ?? "");
    setHistory(view?.history ?? []);
    setHistoryIndex(view?.historyIndex ?? -1);
    setSortKey(view?.sortKey ?? "name");
    setSortAscending(view?.sortAscending ?? true);
    setQuery(view?.query ?? "");
    setSearchId(view?.searchId ?? null);
    setSearchResults(view?.searchResults ?? null);
    setSearchScanned(view?.searchScanned ?? 0);
    setSearchTruncated(view?.searchTruncated ?? false);
    setSelectedRefs(view?.selectedRefs ?? new Set());
    setFocusedIndex(view?.focusedIndex ?? 0);
  }, []);

  const navigate = useCallback(async (
    session: WorkspaceFilesSession,
    path: string | null,
    options: { manual: boolean; replaceHistory?: boolean } = { manual: true }
  ) => {
    const requestId = ++requestSequence.current;
    setLoading(true);
    try {
      const nextPage = await api.listDirectory({
        fileSessionId: session.fileSessionId,
        path,
        snapshotId: null,
        cursor: null,
        pageSize: 500,
        sort: sortRef.current.key,
        direction: sortRef.current.ascending ? "asc" : "desc"
      });
      if (requestId !== requestSequence.current) return;
      pageSortSignatureRef.current = [
        session.fileSessionId,
        nextPage.canonicalPath,
        sortRef.current.key,
        sortRef.current.ascending ? "asc" : "desc"
      ].join("\u0000");
      setPage(nextPage);
      setPathInput(nextPage.canonicalPath);
      setSelectedRefs(new Set());
      setFocusedIndex(0);
      setSearchResults(null);
      setSearchId(null);
      if (options.manual) onFollowCwdChange(false);
      if (options.replaceHistory) return;
      setHistory((current) => {
        const kept = current.slice(0, historyIndexRef.current + 1);
        return [...kept, nextPage.canonicalPath];
      });
      setHistoryIndex(historyIndexRef.current + 1);
    } catch (error) {
      if (requestId === requestSequence.current) onError(error);
    } finally {
      if (requestId === requestSequence.current) setLoading(false);
    }
  }, [api, onError, onFollowCwdChange]);

  useEffect(() => {
    const previousHostAlias = activeHostRef.current;
    if (previousHostAlias && previousHostAlias !== selectedHostAlias && currentViewRef.current) {
      hostViewsRef.current.set(previousHostAlias, currentViewRef.current);
    }
    activeHostRef.current = selectedHostAlias;
    requestSequence.current += 1;
    if (!isActive) return;
    if (!selectedHostAlias) {
      restoreHostView(null);
      setFilesError(false);
      return;
    }
    const cachedView = hostViewsRef.current.get(selectedHostAlias);
    if (cachedView) {
      restoreHostView(cachedView);
      setFilesError(false);
      return;
    }
    let disposed = false;
    setLoading(true);
    setFilesError(false);
    restoreHostView(null);
    void api.openFiles({ hostAlias: selectedHostAlias }).then(async (session) => {
      if (disposed) return;
      setFileSession(session);
      setHistory([]);
      setHistoryIndex(-1);
      await navigate(session, null, { manual: false });
    }).catch((error) => {
      if (!disposed) {
        setFilesError(true);
        onError(error);
      }
    }).finally(() => {
      if (!disposed) setLoading(false);
    });
    return () => {
      disposed = true;
      requestSequence.current += 1;
    };
  }, [api, connectionAttempt, isActive, navigate, onError, restoreHostView, selectedHostAlias]);

  useEffect(() => {
    let disposed = false;
    let unsubscribe: () => void = () => undefined;
    void Promise.resolve(api.events.onFileSearchUpdated((event) => {
      if (event.searchId !== searchId) return;
      setSearchResults((current) => [...(current ?? []), ...event.entries]);
      setSearchScanned(event.scanned);
      setSearchTruncated(event.truncated);
      if (event.state !== "running") setSearchId(null);
      if (event.state === "failed" && event.reason) onError(new Error(event.reason));
    })).then((stop) => {
      if (disposed) stop();
      else unsubscribe = stop;
    }).catch(onError);
    return () => { disposed = true; unsubscribe(); };
  }, [api, onError, searchId]);

  useEffect(() => {
    if (!isActive || !fileSession) return;
    let disposed = false;
    let unsubscribe: () => void = () => undefined;
    void Promise.resolve(api.events.onLocalDrop((event) => {
      if (disposed || !page || event.grants.length === 0) return;
      void api.enqueueTransfers({
        direction: "upload",
        hostAlias: selectedHostAlias,
        fileSessionId: fileSession.fileSessionId,
        sourceEntryRefs: [],
        localGrantIds: event.grants.map((grant) => grant.grantId),
        destinationPath: page.canonicalPath,
        conflictPolicy: "ask"
      }).then(() => onTransfersQueued?.()).catch(onError);
    })).then((stop) => {
      if (disposed) stop();
      else unsubscribe = stop;
    }).catch(onError);
    return () => { disposed = true; unsubscribe(); };
  }, [api, fileSession, isActive, onError, onTransfersQueued, page, selectedHostAlias]);

  useEffect(() => {
    if (!isActive || !followCwd || !fileSession || !activeTerminal || !cwd?.path) return;
    if (activeTerminal.hostAlias !== selectedHostAlias || cwd.source === "unknown") return;
    if (cwd.path === page?.canonicalPath) return;
    void navigate(fileSession, cwd.path, { manual: false });
  }, [activeTerminal, cwd, fileSession, followCwd, isActive, navigate, page?.canonicalPath, selectedHostAlias]);

  useEffect(() => {
    if (!isActive || !followCwd || !fileSession || !activeTerminal || activeTerminal.hostAlias !== selectedHostAlias) return;
    let disposed = false;
    const validate = () => {
      void api.validateTerminalCwd({
        sessionId: activeTerminal.sessionId,
        generation: activeTerminal.generation,
        fileSessionId: fileSession.fileSessionId
      }).catch((error) => {
        // OSC 7 is optional. An unknown cwd is a normal capability state,
        // while validation or SFTP failures remain visible to the user.
        if (!String(error).includes("terminal-cwd-unknown") && !disposed) onError(error);
      });
    };
    validate();
    const timer = window.setInterval(validate, 2000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [activeTerminal, api, fileSession, followCwd, isActive, onError, selectedHostAlias]);

  useEffect(() => {
    const focusLocation = () => {
      locationRef.current?.focus();
      locationRef.current?.select();
    };
    document.addEventListener(WORKSPACE_FILES_LOCATION_EVENT, focusLocation);
    return () => document.removeEventListener(WORKSPACE_FILES_LOCATION_EVENT, focusLocation);
  }, []);

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    window.addEventListener("pointerdown", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("blur", close);
    };
  }, [contextMenu]);

  const entries = useMemo(() => {
    const source = searchResults ?? page?.entries ?? [];
    return searchResults === null && query
      ? source.filter((entry) => entry.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
      : source;
  }, [page?.entries, query, searchResults]);

  const selectedEntries = entries.filter((entry) => selectedRefs.has(entry.entryRef));

  const loadMore = async () => {
    if (!fileSession || !page?.nextCursor) return;
    setLoading(true);
    try {
      const next = await api.listDirectory({
        fileSessionId: fileSession.fileSessionId,
        path: page.canonicalPath,
        snapshotId: page.snapshotId,
        cursor: page.nextCursor,
        pageSize: 500,
        sort: sortKey,
        direction: sortAscending ? "asc" : "desc"
      });
      setPage((current) => current && current.snapshotId === next.snapshotId
        ? { ...next, entries: [...current.entries, ...next.entries] }
        : next);
    } catch (error) {
      onError(error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!fileSession || !page) return;
    const signature = [
      fileSession.fileSessionId,
      page.canonicalPath,
      sortKey,
      sortAscending ? "asc" : "desc"
    ].join("\u0000");
    if (pageSortSignatureRef.current === signature) return;
    void navigate(fileSession, page.canonicalPath, { manual: false, replaceHistory: true });
  }, [fileSession, navigate, page?.canonicalPath, sortAscending, sortKey]);

  const startSearch = async () => {
    if (!fileSession || !page || !query.trim()) return;
    if (searchId) {
      await api.cancelFileSearch({ searchId }).catch(onError);
      setSearchId(null);
      return;
    }
    setSearchResults([]);
    setSearchScanned(0);
    setSearchTruncated(false);
    try {
      const result = await api.startFileSearch({
        fileSessionId: fileSession.fileSessionId,
        path: page.canonicalPath,
        query: query.trim()
      });
      setSearchId(result.searchId);
    } catch (error) {
      setSearchResults(null);
      onError(error);
    }
  };

  const showPreview = async (entry: RemoteFileEntry) => {
    if (!fileSession) return;
    try {
      setPreview(await api.previewFile({ fileSessionId: fileSession.fileSessionId, entryRef: entry.entryRef }));
    } catch (error) {
      onError(error);
    }
  };

  const askOperation = (operation: WorkspaceFileOperationKind, entry: RemoteFileEntry | null, destinationPath: string | null = null) => {
    if (entry?.nameEncoding === "unsupported") return;
    if (operation === "delete" || operation === "move") {
      const pending = { operation, entry, name: "", destinationPath };
      setPendingOperation(pending);
      void prepareOperation(pending);
      return;
    }
    setPendingOperation({ operation, entry, name: operation === "rename" ? entry?.name ?? "" : "", destinationPath });
  };

  const prepareOperation = async (pending = pendingOperation) => {
    if (!fileSession || !pending) return;
    const name = pending.name.trim();
    if (["rename", "create-directory"].includes(pending.operation) && (!name || name.includes("/") || name.includes("\\"))) return;
    setOperationBusy(true);
    try {
      if (pending.operation === "create-directory") {
        await api.createDirectory({
          fileSessionId: fileSession.fileSessionId,
          parentPath: pending.destinationPath ?? page?.canonicalPath ?? fileSession.homePath,
          name
        });
        setPendingOperation(null);
        setOperationPreview(null);
        await navigate(fileSession, page?.canonicalPath ?? null, { manual: false, replaceHistory: true });
        return;
      }
      const destinationPath = pending.operation === "rename" && pending.entry
        ? childPath(parentPath(pending.entry.canonicalPath), name)
        : pending.operation === "move" && pending.entry && pending.destinationPath
          ? childPath(pending.destinationPath, pending.entry.name)
          : pending.destinationPath;
      const prepared = await api.prepareFileOperation({
        fileSessionId: fileSession.fileSessionId,
        operation: pending.operation,
        entryRef: pending.entry?.entryRef ?? null,
        destinationPath,
        name: null
      });
      setOperationPreview(prepared);
    } catch (error) {
      onError(error);
    } finally {
      setOperationBusy(false);
    }
  };

  const confirmOperation = async () => {
    if (!operationPreview || !fileSession) return;
    setOperationBusy(true);
    try {
      const result = await api.confirmFileOperation({ token: operationPreview.token });
      if (result.recovery) {
        onRecoveryCreated(result.recovery);
        setCreatedRecovery(result.recovery);
      }
      setOperationPreview(null);
      setPendingOperation(null);
      await navigate(fileSession, page?.canonicalPath ?? null, { manual: false, replaceHistory: true });
    } catch (error) {
      onError(error);
    } finally {
      setOperationBusy(false);
    }
  };

  const upload = async (destinationPath = page?.canonicalPath ?? null) => {
    if (!fileSession || !destinationPath) return;
    try {
      const grants = await api.selectUploadSources();
      if (grants.length === 0) return;
      await api.enqueueTransfers({
        direction: "upload",
        hostAlias: selectedHostAlias,
        fileSessionId: fileSession.fileSessionId,
        sourceEntryRefs: [],
        localGrantIds: grants.map((grant) => grant.grantId),
        destinationPath,
        conflictPolicy: "ask"
      });
      onTransfersQueued?.();
    } catch (error) {
      onError(error);
    }
  };

  const download = async (targets = selectedEntries) => {
    if (!fileSession || targets.length === 0) return;
    try {
      const grant = await api.selectDownloadTarget();
      if (!grant) return;
      await api.enqueueTransfers({
        direction: "download",
        hostAlias: selectedHostAlias,
        fileSessionId: fileSession.fileSessionId,
        sourceEntryRefs: targets.map((entry) => entry.entryRef),
        localGrantIds: [grant.grantId],
        destinationPath: null,
        conflictPolicy: "ask"
      });
      onTransfersQueued?.();
    } catch (error) {
      onError(error);
    }
  };

  const openEntry = (entry: RemoteFileEntry) => {
    if (!fileSession) return;
    if (entry.kind === "directory") void navigate(fileSession, entry.canonicalPath, { manual: true });
    else void showPreview(entry);
  };

  const focusRow = (index: number) => {
    const bounded = Math.max(0, Math.min(entries.length - 1, index));
    setFocusedIndex(bounded);
    rowRefs.current.get(entries[bounded]?.entryRef ?? "")?.focus();
  };

  const handleGridKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>, entry: RemoteFileEntry, index: number) => {
    if (event.key === "ArrowDown") { event.preventDefault(); focusRow(index + 1); }
    if (event.key === "ArrowUp") { event.preventDefault(); focusRow(index - 1); }
    if (event.key === "Home") { event.preventDefault(); focusRow(0); }
    if (event.key === "End") { event.preventDefault(); focusRow(entries.length - 1); }
    if (event.key === "Enter") { event.preventDefault(); openEntry(entry); }
    if (event.key === " ") { event.preventDefault(); void showPreview(entry); }
    if (event.key === "F2" && entry.writable) { event.preventDefault(); askOperation("rename", entry); }
    if (event.key === "Delete" && entry.writable) { event.preventDefault(); askOperation("delete", entry); }
    if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
      event.preventDefault();
      const rect = event.currentTarget.getBoundingClientRect();
      setContextMenu({ entry, x: rect.left + 24, y: rect.top + 24 });
    }
  };

  const locateTerminal = async () => {
    if (!fileSession || !activeTerminal || activeTerminal.hostAlias !== selectedHostAlias) return;
    try {
      const verified = await api.validateTerminalCwd({
        sessionId: activeTerminal.sessionId,
        generation: activeTerminal.generation,
        fileSessionId: fileSession.fileSessionId
      });
      if (!verified.path || verified.source === "unknown") throw new Error(copy.cwdUnavailable);
      onFollowCwdChange(true);
      await navigate(fileSession, verified.path, { manual: false });
    } catch (error) {
      onError(error);
    }
  };

  const canLocate = Boolean(fileSession && activeTerminal && activeTerminal.hostAlias === selectedHostAlias);
  const operationNameValid = pendingOperation
    ? !["rename", "create-directory"].includes(pendingOperation.operation)
      || Boolean(pendingOperation.name.trim() && !/[\\/]/.test(pendingOperation.name))
    : false;

  return (
    <section className="workspaceFilesPanel" aria-label={copy.modes.files}>
      <div className="workspacePaneToolbar workspaceFilesHostToolbar">
        <label>
          <span>{copy.host}</span>
          <select value={selectedHostAlias} onChange={(event) => onHostSelected(event.target.value)}>
            <option value="">{copy.selectHost}</option>
            {hosts.map((host) => <option key={host.id} value={host.hostAlias}>{host.name} · {host.hostAlias}</option>)}
          </select>
        </label>
        <button
          aria-pressed={followCwd}
          className="workspaceToggleButton"
          disabled={!canLocate}
          title={!canLocate ? copy.cwdUnavailable : copy.followCwd}
          type="button"
          onClick={() => { if (followCwd) onFollowCwdChange(false); else void locateTerminal(); }}
        >◎ {copy.followCwd}</button>
        <button disabled={!canLocate} title={!canLocate ? copy.cwdUnavailable : copy.locateTerminal} type="button" onClick={() => void locateTerminal()}>⌾</button>
      </div>

      <div className="workspacePaneToolbar workspaceFilesNavigation">
        <div className="workspaceButtonGroup">
          <button aria-label={copy.back} disabled={!fileSession || historyIndex <= 0} title={copy.back} type="button" onClick={() => {
            if (!fileSession || historyIndex <= 0) return;
            const nextIndex = historyIndex - 1;
            setHistoryIndex(nextIndex);
            void navigate(fileSession, history[nextIndex], { manual: true, replaceHistory: true });
          }}>←</button>
          <button aria-label={copy.forward} disabled={!fileSession || historyIndex >= history.length - 1} title={copy.forward} type="button" onClick={() => {
            if (!fileSession || historyIndex >= history.length - 1) return;
            const nextIndex = historyIndex + 1;
            setHistoryIndex(nextIndex);
            void navigate(fileSession, history[nextIndex], { manual: true, replaceHistory: true });
          }}>→</button>
          <button aria-label={copy.up} disabled={!fileSession || !page || page.canonicalPath === "/"} title={copy.up} type="button" onClick={() => {
            if (fileSession && page) void navigate(fileSession, parentPath(page.canonicalPath), { manual: true });
          }}>↑</button>
          <button aria-label={copy.home} disabled={!fileSession} title={copy.home} type="button" onClick={() => {
            if (fileSession) void navigate(fileSession, fileSession.homePath, { manual: true });
          }}>⌂</button>
          <button aria-label={copy.refresh} disabled={!fileSession} title={copy.refresh} type="button" onClick={() => {
            if (fileSession) void navigate(fileSession, page?.canonicalPath ?? null, { manual: false, replaceHistory: true });
          }}>↻</button>
        </div>
        <form className="workspaceLocationForm" onSubmit={(event) => {
          event.preventDefault();
          if (fileSession && pathInput.trim()) void navigate(fileSession, pathInput.trim(), { manual: true });
        }}>
          <label className="workspaceVisuallyHidden" htmlFor="workspace-files-location">{copy.location}</label>
          <input ref={locationRef} id="workspace-files-location" value={pathInput} onChange={(event) => setPathInput(event.target.value)} />
        </form>
      </div>

      <div className="workspacePaneToolbar workspaceFilesActions">
        <form className="workspaceSearchForm" onSubmit={(event) => { event.preventDefault(); void startSearch(); }}>
          <label className="workspaceVisuallyHidden" htmlFor="workspace-file-search">{copy.searchFiles}</label>
          <input id="workspace-file-search" placeholder={copy.searchFiles} title={copy.recursiveSearch} value={query} onChange={(event) => {
            setQuery(event.target.value);
            if (!event.target.value) setSearchResults(null);
          }} />
          <button type="submit" disabled={!query.trim()}>{searchId ? copy.stopSearch : "⌕"}</button>
        </form>
        <label className="workspaceCompactSelect">
          <span className="workspaceVisuallyHidden">{copy.sortBy}</span>
          <select value={sortKey} onChange={(event) => setSortKey(event.target.value as SortKey)}>
            <option value="name">{copy.sortName}</option>
            <option value="type">{copy.sortType}</option>
            <option value="size">{copy.sortSize}</option>
            <option value="modified">{copy.sortModified}</option>
          </select>
        </label>
        <button aria-label={sortAscending ? copy.ascending : copy.descending} title={sortAscending ? copy.ascending : copy.descending} type="button" onClick={() => setSortAscending((value) => !value)}>{sortAscending ? "↑" : "↓"}</button>
        <button disabled={!fileSession} type="button" onClick={() => void upload()}>⇧ {copy.upload}</button>
        <button disabled={selectedEntries.length === 0} type="button" onClick={() => void download()}>⇩ {copy.download}</button>
        <button disabled={!fileSession || !page} type="button" onClick={() => askOperation("create-directory", null, page?.canonicalPath ?? null)}>＋ {copy.newFolder}</button>
      </div>

      {!followCwd && activeTerminal?.hostAlias === selectedHostAlias ? <div className="workspaceInfoBar">{copy.followCwdPaused}</div> : null}
      {searchResults !== null ? <div className="workspaceSearchSummary">{searchScanned} {copy.scanned}{searchTruncated ? ` · ${copy.resultsTruncated}` : ""}</div> : null}
      {createdRecovery ? (
        <div className="workspaceRecoveryNotice" role="status">
          <span>{copy.recoveryReady}</span>
          <button type="button" onClick={onViewRecoveries}>{copy.viewRecovery}</button>
          <button aria-label={copy.close} type="button" onClick={() => setCreatedRecovery(null)}>×</button>
        </div>
      ) : null}

      <div className="workspaceFileGrid" role="grid" aria-busy={loading} aria-label={page?.canonicalPath ?? copy.modes.files}>
        <div className="workspaceFileGridHeader" role="row">
          <span role="columnheader">{copy.fileName}</span>
          <span role="columnheader">{copy.fileType}</span>
          <span role="columnheader">{copy.fileSize}</span>
          <span role="columnheader">{copy.fileModified}</span>
        </div>
        <div className="workspaceFileGridBody" role="rowgroup">
          {entries.map((entry, index) => (
            <div
              aria-selected={selectedRefs.has(entry.entryRef)}
              className="workspaceFileRow"
              data-kind={entry.kind}
              draggable={entry.writable && entry.nameEncoding === "utf8"}
              key={entry.entryRef}
              ref={(node) => { if (node) rowRefs.current.set(entry.entryRef, node); else rowRefs.current.delete(entry.entryRef); }}
              role="row"
              tabIndex={focusedIndex === index ? 0 : -1}
              onClick={(event) => {
                setFocusedIndex(index);
                setSelectedRefs((current) => {
                  if (event.ctrlKey || event.metaKey) {
                    const next = new Set(current);
                    if (next.has(entry.entryRef)) next.delete(entry.entryRef); else next.add(entry.entryRef);
                    return next;
                  }
                  return new Set([entry.entryRef]);
                });
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                setSelectedRefs(new Set([entry.entryRef]));
                setContextMenu({ entry, x: event.clientX, y: event.clientY });
              }}
              onDoubleClick={() => openEntry(entry)}
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("application/x-codexhub-remote-entry-ref", entry.entryRef);
              }}
              onDragOver={(event) => { if (entry.kind === "directory") event.preventDefault(); }}
              onDrop={(event) => {
                if (entry.kind !== "directory") return;
                const entryRef = event.dataTransfer.getData("application/x-codexhub-remote-entry-ref");
                const source = entries.find((candidate) => candidate.entryRef === entryRef);
                if (source && source.entryRef !== entry.entryRef) {
                  event.preventDefault();
                  askOperation("move", source, entry.canonicalPath);
                }
              }}
              onKeyDown={(event) => handleGridKeyDown(event, entry, index)}
            >
              <span className="workspaceFileName" role="gridcell" title={entry.canonicalPath}><span aria-hidden="true">{iconForEntry(entry)}</span>{entry.name}</span>
              <span role="gridcell">{kindLabel(entry, copy)}</span>
              <span role="gridcell">{entry.kind === "directory" ? "—" : displaySize(entry.size)}</span>
              <span role="gridcell">{formatModifiedAt(entry.modifiedAt)}</span>
            </div>
          ))}
          {!loading && filesError ? (
            <div className="workspaceEmptyState workspaceFileEmpty" role="alert">
              <p>{copy.filesUnavailable}</p>
              <button type="button" onClick={() => setConnectionAttempt((value) => value + 1)}>{copy.retryLoad}</button>
            </div>
          ) : null}
          {!loading && !filesError && entries.length === 0 ? <div className="workspaceEmptyState workspaceFileEmpty">{selectedHostAlias ? copy.emptyDirectory : copy.noHosts}</div> : null}
          {loading ? <div className="workspacePaneState">{copy.loading}</div> : null}
        </div>
      </div>
      {page?.nextCursor && searchResults === null ? <button className="workspaceLoadMore" disabled={loading} type="button" onClick={() => void loadMore()}>{copy.loadMore}</button> : null}

      {contextMenu ? (
        <div className="workspaceContextMenu" role="menu" style={{ left: contextMenu.x, top: contextMenu.y }} onPointerDown={(event) => event.stopPropagation()}>
          <button role="menuitem" type="button" onClick={() => { openEntry(contextMenu.entry); setContextMenu(null); }}>{copy.open}</button>
          <button role="menuitem" type="button" onClick={() => { void showPreview(contextMenu.entry); setContextMenu(null); }}>{copy.preview}</button>
          <button role="menuitem" type="button" onClick={() => { void download([contextMenu.entry]); setContextMenu(null); }}>{copy.download}</button>
          {contextMenu.entry.kind === "directory" ? <button role="menuitem" type="button" onClick={() => { void upload(contextMenu.entry.canonicalPath); setContextMenu(null); }}>{copy.uploadHere}</button> : null}
          <button role="menuitem" type="button" disabled={!contextMenu.entry.writable || contextMenu.entry.nameEncoding !== "utf8"} onClick={() => { askOperation("rename", contextMenu.entry); setContextMenu(null); }}>{copy.rename}</button>
          <button role="menuitem" type="button" disabled={!contextMenu.entry.writable || contextMenu.entry.nameEncoding !== "utf8"} onClick={() => { askOperation("delete", contextMenu.entry); setContextMenu(null); }}>{copy.delete}</button>
          <button role="menuitem" type="button" onClick={() => { void navigator.clipboard.writeText(contextMenu.entry.canonicalPath).catch(onError); setContextMenu(null); }}>{copy.copyPath}</button>
          <button
            disabled={!fileSession}
            role="menuitem"
            title={!fileSession ? copy.terminalHereUnavailable : copy.openTerminalHere}
            type="button"
            onClick={() => {
              if (fileSession) {
                onOpenTerminalAt(
                  selectedHostAlias,
                  fileSession.fileSessionId,
                  contextMenu.entry.kind === "directory" ? contextMenu.entry.canonicalPath : parentPath(contextMenu.entry.canonicalPath)
                );
              }
              setContextMenu(null);
            }}
          >{copy.openTerminalHere}</button>
        </div>
      ) : null}

      {preview ? (
        <div className="workspaceInlineDialogBackdrop" role="presentation">
          <section aria-labelledby="workspace-preview-title" className="workspaceInlineDialog workspacePreviewDialog" role="dialog" aria-modal="true">
            <header><h3 id="workspace-preview-title">{copy.previewTitle}: {preview.name}</h3><button aria-label={copy.close} type="button" onClick={() => setPreview(null)}>×</button></header>
            <div className="workspacePreviewBody">
              {preview.kind === "text" && preview.text !== null ? <pre>{preview.text}</pre> : null}
              {preview.kind === "image" && preview.dataBase64 && preview.mimeType && SAFE_IMAGE_TYPES.has(preview.mimeType)
                ? <img alt={preview.name} src={`data:${preview.mimeType};base64,${preview.dataBase64}`} />
                : null}
              {preview.blockedReason ? <p role="alert">{copy.previewBlocked} {preview.blockedReason}</p> : null}
              {preview.kind === "metadata" && !preview.blockedReason ? <p>{copy.noPreview}</p> : null}
            </div>
            <footer>{preview.mimeType ?? copy.unknown} · {displaySize(preview.size)}{preview.truncated ? " · …" : ""}</footer>
          </section>
        </div>
      ) : null}

      {pendingOperation ? (
        <div className="workspaceInlineDialogBackdrop" role="presentation">
          <section aria-labelledby="workspace-operation-title" className="workspaceInlineDialog workspaceOperationDialog" role="alertdialog" aria-modal="true">
            <h3 id="workspace-operation-title">{copy.operationTitle}</h3>
            {!operationPreview && ["rename", "create-directory"].includes(pendingOperation.operation) ? (
              <label>{pendingOperation.operation === "create-directory" ? copy.folderName : copy.destinationName}
                <input autoFocus value={pendingOperation.name} onChange={(event) => setPendingOperation((current) => current ? { ...current, name: event.target.value } : current)} />
                {!operationNameValid ? <small role="alert">{copy.invalidName}</small> : null}
              </label>
            ) : null}
            {operationPreview ? (
              <div className="workspaceOperationPreview">
                <dl>
                  <dt>{copy.host}</dt><dd>{operationPreview.hostAlias}</dd>
                  {operationPreview.sourcePath ? <><dt>{copy.source}</dt><dd>{operationPreview.sourcePath}</dd></> : null}
                  {operationPreview.targetPath ? <><dt>{copy.destination}</dt><dd>{operationPreview.targetPath}</dd></> : null}
                  {operationPreview.backupPath ? <><dt>{copy.backup}</dt><dd>{operationPreview.backupPath}</dd></> : null}
                </dl>
                <p>{operationPreview.impactSummary}</p>
                <p className="workspaceWarningText">{copy.operationExpires}</p>
              </div>
            ) : null}
            <div className="workspaceDialogActions">
              <button disabled={operationBusy} type="button" onClick={() => { setPendingOperation(null); setOperationPreview(null); }}>{copy.cancel}</button>
              {!operationPreview ? <button className="workspacePrimaryButton" disabled={operationBusy || !operationNameValid} type="button" onClick={() => void prepareOperation()}>{operationBusy ? copy.busy : pendingOperation.operation === "create-directory" ? copy.confirmOperation : copy.preview}</button> : null}
              {operationPreview ? <button className="workspaceDangerButton" disabled={operationBusy} type="button" onClick={() => void confirmOperation()}>{operationBusy ? copy.busy : copy.confirmOperation}</button> : null}
            </div>
          </section>
        </div>
      ) : null}
    </section>
  );
}
