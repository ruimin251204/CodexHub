import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
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
  WorkspaceLocale,
  WorkspaceRecovery,
  WorkspaceTerminalCwdEvent,
  WorkspaceTerminalSession
} from "./types";
import { workspaceHostLabel } from "./hostLabel";
import { usePersonalInfoMasking } from "../ui/PersonalInfoMasking";
import { DirectoryTree } from "./files/DirectoryTree";
import { FileOperationDialog, FilePreviewDialog } from "./files/FileDialogs";
import type { PendingFileOperation } from "./files/FileDialogs";
import { FileTable } from "./files/FileTable";
import { FilesIcon } from "./files/FilesIcon";
import { childPath, parentPath } from "./files/fileDisplay";
import { filesUiCopy } from "./files/filesUiCopy";
import "./files-redesign.css";

export { formatModifiedAt } from "./files/fileDisplay";

export const WORKSPACE_FILES_LOCATION_EVENT = "codexhub:workspace-files-location";

type SortKey = WorkspaceFileSortField;

const TREE_MIN_WIDTH = 180;
const TREE_MAX_WIDTH = 520;
const FILES_TABLE_MIN_WIDTH = 360;
const DEFAULT_TREE_WIDTH = 248;

type FilesHostView = {
  fileSession: WorkspaceFilesSession | null;
  page: WorkspaceDirectoryPage | null;
  filesError: boolean;
  failedPath: string | null;
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
  directoryEntriesByPath: Map<string, RemoteFileEntry[]>;
  expandedTreePaths: Set<string>;
  clientPage: number;
  clientPageSize: number;
};

function pathAncestry(path: string) {
  const ancestry = new Set<string>(["/"]);
  let cursor = path;
  while (cursor !== "/") {
    ancestry.add(cursor);
    cursor = parentPath(cursor);
  }
  return ancestry;
}

export function FilesPanel({
  activeTerminal,
  api,
  copy,
  cwd,
  followCwd,
  hosts,
  isActive,
  locale = "en",
  compact = false,
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
  locale?: WorkspaceLocale;
  /** The parent marks the split surface compact; entering it closes the tree once. */
  compact?: boolean;
  selectedHostAlias: string;
  onError: (error: unknown) => void;
  onFollowCwdChange: (follow: boolean) => void;
  onHostSelected: (hostAlias: string) => void;
  onOpenTerminalAt: (hostAlias: string, fileSessionId: string, path: string) => void;
  onRecoveryCreated: (recovery: WorkspaceRecovery) => void;
  onViewRecoveries: () => void;
  onTransfersQueued?: () => void;
}) {
  const ui = filesUiCopy[locale];
  const personalInfo = usePersonalInfoMasking();
  const [fileSession, setFileSession] = useState<WorkspaceFilesSession | null>(null);
  const [page, setPage] = useState<WorkspaceDirectoryPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [pathInput, setPathInput] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortAscending, setSortAscending] = useState(true);
  const [query, setQuery] = useState("");
  const [showHidden, setShowHidden] = useState(false);
  const [searchId, setSearchId] = useState<string | null>(null);
  const [searchResults, setSearchResults] = useState<RemoteFileEntry[] | null>(null);
  const [searchScanned, setSearchScanned] = useState(0);
  const [searchTruncated, setSearchTruncated] = useState(false);
  const [selectedRefs, setSelectedRefs] = useState<Set<string>>(() => new Set());
  const [focusedIndex, setFocusedIndex] = useState(0);
  const [directoryEntriesByPath, setDirectoryEntriesByPath] = useState<Map<string, RemoteFileEntry[]>>(() => new Map());
  const [expandedTreePaths, setExpandedTreePaths] = useState<Set<string>>(() => new Set(["/"]));
  const [loadingTreePaths, setLoadingTreePaths] = useState<Set<string>>(() => new Set());
  const [clientPage, setClientPage] = useState(0);
  const [clientPageSize, setClientPageSize] = useState(50);
  const [treeCollapsed, setTreeCollapsed] = useState(() => compact);
  const [treeWidth, setTreeWidth] = useState(DEFAULT_TREE_WIDTH);
  const [treeResizing, setTreeResizing] = useState(false);
  const [preview, setPreview] = useState<WorkspaceFilePreview | null>(null);
  const [contextMenu, setContextMenu] = useState<{ entry: RemoteFileEntry; x: number; y: number } | null>(null);
  const [pendingOperation, setPendingOperation] = useState<PendingFileOperation | null>(null);
  const [operationPreview, setOperationPreview] = useState<WorkspaceFileOperationPreview | null>(null);
  const [operationBusy, setOperationBusy] = useState(false);
  const [filesError, setFilesError] = useState(false);
  const [failedPath, setFailedPath] = useState<string | null>(null);
  const [createdRecovery, setCreatedRecovery] = useState<WorkspaceRecovery | null>(null);
  const [connectionAttempt, setConnectionAttempt] = useState(0);
  const locationRef = useRef<HTMLInputElement>(null);
  const moreActionsRef = useRef<HTMLDetailsElement>(null);
  const explorerRef = useRef<HTMLDivElement>(null);
  const treeResizeCleanupRef = useRef<(() => void) | null>(null);
  const requestSequence = useRef(0);
  const historyIndexRef = useRef(-1);
  const pageSortSignatureRef = useRef("");
  const sortRef = useRef({ key: sortKey, ascending: sortAscending });
  const hostViewsRef = useRef(new Map<string, FilesHostView>());
  const failedHostAliasesRef = useRef(new Set<string>());
  const failedFileSessionIdsRef = useRef(new Map<string, string>());
  const activeHostRef = useRef("");
  const compactModeRef = useRef(compact);
  const currentViewRef = useRef<FilesHostView | null>(null);
  const retryRequestRef = useRef<{ hostAlias: string; path: string | null } | null>(null);

  useEffect(() => () => treeResizeCleanupRef.current?.(), []);

  useEffect(() => {
    // A user may open the tree while staying in Split, so only close it when
    // the parent actually enters compact mode instead of on every rerender.
    if (compact && !compactModeRef.current) setTreeCollapsed(true);
    compactModeRef.current = compact;
  }, [compact]);

  const treeWidthLimit = useCallback(() => {
    const availableWidth = explorerRef.current?.clientWidth;
    if (!availableWidth) return TREE_MAX_WIDTH;
    const remainingFileWidth = compact ? 72 : FILES_TABLE_MIN_WIDTH;
    return Math.max(TREE_MIN_WIDTH, Math.min(TREE_MAX_WIDTH, availableWidth - remainingFileWidth));
  }, [compact]);

  const clampTreeWidth = useCallback((width: number) => (
    Math.max(TREE_MIN_WIDTH, Math.min(treeWidthLimit(), Math.round(width)))
  ), [treeWidthLimit]);

  // The divider owns only layout state; navigating SFTP paths never resets a user-selected tree width.
  const startTreeResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    treeResizeCleanupRef.current?.();

    const initialX = event.clientX;
    const initialWidth = treeWidth;
    const move = (pointerEvent: PointerEvent) => {
      setTreeWidth(clampTreeWidth(initialWidth + pointerEvent.clientX - initialX));
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      treeResizeCleanupRef.current = null;
      setTreeResizing(false);
    };

    treeResizeCleanupRef.current = stop;
    setTreeResizing(true);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
  };

  const handleTreeResizeKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    const step = event.shiftKey ? 48 : 16;
    const delta = event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0;
    if (!delta) return;
    event.preventDefault();
    setTreeWidth((current) => clampTreeWidth(current + delta));
  };

  historyIndexRef.current = historyIndex;
  sortRef.current = { key: sortKey, ascending: sortAscending };
  currentViewRef.current = {
    fileSession,
    page,
    filesError,
    failedPath,
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
    focusedIndex,
    directoryEntriesByPath,
    expandedTreePaths,
    clientPage,
    clientPageSize
  };

  const restoreHostView = useCallback((view: FilesHostView | null) => {
    setFileSession(view?.fileSession ?? null);
    setPage(view?.page ?? null);
    setFilesError(view?.filesError ?? false);
    setFailedPath(view?.failedPath ?? null);
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
    setDirectoryEntriesByPath(view?.directoryEntriesByPath ?? new Map());
    setExpandedTreePaths(view?.expandedTreePaths ?? new Set(["/"]));
    setLoadingTreePaths(new Set());
    setClientPage(view?.clientPage ?? 0);
    setClientPageSize(view?.clientPageSize ?? 50);
  }, []);

  const rememberDirectoryPage = useCallback((nextPage: WorkspaceDirectoryPage, append = false) => {
    setDirectoryEntriesByPath((current) => {
      const next = new Map(current);
      const directories = nextPage.entries.filter((entry) => entry.kind === "directory");
      const existing = append ? next.get(nextPage.canonicalPath) ?? [] : [];
      const merged = new Map(existing.map((entry) => [entry.entryRef, entry]));
      for (const entry of directories) merged.set(entry.entryRef, entry);
      next.set(nextPage.canonicalPath, [...merged.values()]);
      return next;
    });
    setExpandedTreePaths((current) => new Set([...current, ...pathAncestry(nextPage.canonicalPath)]));
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
      failedHostAliasesRef.current.delete(session.hostAlias);
      failedFileSessionIdsRef.current.delete(session.hostAlias);
      setFilesError(false);
      setFailedPath(null);
      pageSortSignatureRef.current = [
        session.fileSessionId,
        nextPage.canonicalPath,
        sortRef.current.key,
        sortRef.current.ascending ? "asc" : "desc"
      ].join("\u0000");
      setPage(nextPage);
      rememberDirectoryPage(nextPage);
      setPathInput(nextPage.canonicalPath);
      setSelectedRefs(new Set());
      setFocusedIndex(0);
      setClientPage(0);
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
      if (requestId === requestSequence.current) {
        // A failed list may have left the per-host SFTP child unusable. Mark it
        // for ordered disposal before the next open so it cannot be reused.
        failedHostAliasesRef.current.add(session.hostAlias);
        failedFileSessionIdsRef.current.set(session.hostAlias, session.fileSessionId);
        setFileSession(null);
        setFilesError(true);
        setFailedPath(path);
        onError(error);
      }
    } finally {
      if (requestId === requestSequence.current) setLoading(false);
    }
  }, [api, onError, onFollowCwdChange, rememberDirectoryPage]);

  useEffect(() => {
    const previousHostAlias = activeHostRef.current;
    if (
      previousHostAlias
      && previousHostAlias !== selectedHostAlias
      && currentViewRef.current
      && !failedHostAliasesRef.current.has(previousHostAlias)
    ) {
      hostViewsRef.current.set(previousHostAlias, currentViewRef.current);
    }
    activeHostRef.current = selectedHostAlias;
    requestSequence.current += 1;
    if (!isActive) {
      if (
        selectedHostAlias
        && previousHostAlias === selectedHostAlias
        && currentViewRef.current
        && !failedHostAliasesRef.current.has(selectedHostAlias)
      ) {
        hostViewsRef.current.set(selectedHostAlias, currentViewRef.current);
      }
      return;
    }
    if (!selectedHostAlias) {
      restoreHostView(null);
      return;
    }
    const retryRequest = retryRequestRef.current?.hostAlias === selectedHostAlias
      ? retryRequestRef.current
      : null;
    if (retryRequest) {
      retryRequestRef.current = null;
      hostViewsRef.current.delete(selectedHostAlias);
    }
    const cachedView = hostViewsRef.current.get(selectedHostAlias);
    if (cachedView?.page && !failedHostAliasesRef.current.has(selectedHostAlias) && !retryRequest) {
      restoreHostView(cachedView);
      return;
    }
    hostViewsRef.current.delete(selectedHostAlias);
    let disposed = false;
    setLoading(true);
    restoreHostView(null);
    void (async () => {
      const staleSessionId = failedFileSessionIdsRef.current.get(selectedHostAlias);
      if (staleSessionId) {
        await api.closeFiles({ fileSessionId: staleSessionId }).catch(() => undefined);
        failedFileSessionIdsRef.current.delete(selectedHostAlias);
      }
      if (disposed) return;
      const session = await api.openFiles({ hostAlias: selectedHostAlias });
      if (disposed) return;
      setFileSession(session);
      setHistory([]);
      setHistoryIndex(-1);
      await navigate(session, retryRequest?.path ?? null, { manual: false });
    })().catch((error) => {
      if (!disposed) {
        setFilesError(true);
        setFailedPath(retryRequest?.path ?? null);
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
    const closeMoreActions = (event: PointerEvent) => {
      const menu = moreActionsRef.current;
      const target = event.target;
      if (!menu?.open || !(target instanceof Node) || menu.contains(target)) return;
      menu.open = false;
    };
    const closeMoreActionsOnEscape = (event: KeyboardEvent) => {
      const menu = moreActionsRef.current;
      if (event.key !== "Escape" || !menu?.open) return;
      event.preventDefault();
      menu.open = false;
      menu.querySelector<HTMLElement>("summary")?.focus();
    };
    document.addEventListener("pointerdown", closeMoreActions);
    document.addEventListener("keydown", closeMoreActionsOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeMoreActions);
      document.removeEventListener("keydown", closeMoreActionsOnEscape);
    };
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
    const root = page?.canonicalPath ?? "/";
    const visible = showHidden ? source : source.filter((entry) => {
      const prefix = root === "/" ? "/" : `${root.replace(/\/+$/, "")}/`;
      const relativePath = entry.canonicalPath.startsWith(prefix)
        ? entry.canonicalPath.slice(prefix.length)
        : entry.name;
      return !relativePath.split("/").some((segment) => segment.startsWith(".") && segment.length > 1);
    });
    return searchResults === null && query
      ? visible.filter((entry) => entry.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
      : visible;
  }, [page?.canonicalPath, page?.entries, query, searchResults, showHidden]);

  const selectedEntries = entries.filter((entry) => selectedRefs.has(entry.entryRef));
  const clientPageCount = Math.max(1, Math.ceil(entries.length / clientPageSize));
  const paginatedEntries = useMemo(
    () => entries.slice(clientPage * clientPageSize, (clientPage + 1) * clientPageSize),
    [clientPage, clientPageSize, entries]
  );
  const visibleTreeDirectories = useMemo(() => {
    if (showHidden) return directoryEntriesByPath;
    const next = new Map<string, RemoteFileEntry[]>();
    for (const [path, directoryEntries] of directoryEntriesByPath) {
      next.set(path, directoryEntries.filter((entry) => !entry.name.startsWith(".") || entry.name === "." || entry.name === ".."));
    }
    return next;
  }, [directoryEntriesByPath, showHidden]);

  useEffect(() => {
    setClientPage((current) => Math.min(current, clientPageCount - 1));
  }, [clientPageCount]);

  useEffect(() => {
    setClientPage(0);
    setFocusedIndex(0);
  }, [clientPageSize, page?.canonicalPath, query, showHidden]);

  const toggleTreePath = async (path: string) => {
    const expanded = expandedTreePaths.has(path);
    setExpandedTreePaths((current) => {
      const next = new Set(current);
      if (expanded) next.delete(path); else next.add(path);
      return next;
    });
    if (expanded || !fileSession || directoryEntriesByPath.has(path)) return;
    setLoadingTreePaths((current) => new Set(current).add(path));
    try {
      const treePage = await api.listDirectory({
        fileSessionId: fileSession.fileSessionId,
        path,
        snapshotId: null,
        cursor: null,
        pageSize: 500,
        sort: "name",
        direction: "asc"
      });
      rememberDirectoryPage(treePage);
    } catch (error) {
      onError(error);
    } finally {
      setLoadingTreePaths((current) => {
        const next = new Set(current);
        next.delete(path);
        return next;
      });
    }
  };

  const selectEntry = (entry: RemoteFileEntry, toggle: boolean) => {
    setSelectedRefs((current) => {
      if (!toggle) return new Set([entry.entryRef]);
      const next = new Set(current);
      if (next.has(entry.entryRef)) next.delete(entry.entryRef); else next.add(entry.entryRef);
      return next;
    });
  };

  const selectPage = (selected: boolean) => {
    setSelectedRefs((current) => {
      const next = new Set(current);
      for (const entry of paginatedEntries) {
        if (selected) next.add(entry.entryRef); else next.delete(entry.entryRef);
      }
      return next;
    });
  };

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
      rememberDirectoryPage(next, true);
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
    <section
      className="workspaceFilesPanel workspaceFilesRedesign"
      aria-label={copy.modes.files}
      data-compact={compact}
      data-tree-collapsed={treeCollapsed}
      data-tree-resizing={treeResizing}
    >
      <div className="workspacePaneToolbar workspaceFilesCommandBar">
        <label className="workspaceFilesHostPicker">
          <span>{copy.host}</span>
          <select aria-label={copy.host} value={selectedHostAlias} onChange={(event) => onHostSelected(event.target.value)}>
            <option value="">{copy.localFiles}</option>
            {hosts.map((host) => <option key={host.id} value={host.hostAlias}>{personalInfo.maskText(workspaceHostLabel(host))}</option>)}
          </select>
        </label>
        {fileSession?.state === "connected" ? <span aria-label={ui.sftpConnected} className="workspaceFilesConnection" title={ui.sftpConnected}><i aria-hidden="true" />{ui.sftpConnected}</span> : null}
        <div aria-label={copy.location} className="workspaceButtonGroup workspaceFilesPathActions" role="group">
          <button aria-label={copy.back} disabled={!fileSession || historyIndex <= 0} title={copy.back} type="button" onClick={() => {
            if (!fileSession || historyIndex <= 0) return;
            const nextIndex = historyIndex - 1;
            setHistoryIndex(nextIndex);
            void navigate(fileSession, history[nextIndex], { manual: true, replaceHistory: true });
          }}><FilesIcon name="back" /></button>
          <button aria-label={copy.forward} disabled={!fileSession || historyIndex >= history.length - 1} title={copy.forward} type="button" onClick={() => {
            if (!fileSession || historyIndex >= history.length - 1) return;
            const nextIndex = historyIndex + 1;
            setHistoryIndex(nextIndex);
            void navigate(fileSession, history[nextIndex], { manual: true, replaceHistory: true });
          }}><FilesIcon name="forward" /></button>
          <button aria-label={copy.up} disabled={!fileSession || !page || page.canonicalPath === "/"} title={copy.up} type="button" onClick={() => {
            if (fileSession && page) void navigate(fileSession, parentPath(page.canonicalPath), { manual: true });
          }}><FilesIcon name="up" /></button>
          <button aria-label={copy.home} disabled={!fileSession} title={copy.home} type="button" onClick={() => {
            if (fileSession) void navigate(fileSession, fileSession.homePath, { manual: true });
          }}><FilesIcon name="home" /></button>
          <button aria-label={copy.refresh} disabled={!fileSession} title={copy.refresh} type="button" onClick={() => {
            if (fileSession) void navigate(fileSession, page?.canonicalPath ?? null, { manual: false, replaceHistory: true });
          }}><FilesIcon name="refresh" /></button>
        </div>
        <form className="workspaceLocationForm" onSubmit={(event) => {
          event.preventDefault();
          if (fileSession && pathInput.trim()) void navigate(fileSession, pathInput.trim(), { manual: true });
        }}>
          <label className="workspaceVisuallyHidden" htmlFor="workspace-files-location">{copy.location}</label>
          <input ref={locationRef} id="workspace-files-location" title={pathInput} value={pathInput} onChange={(event) => setPathInput(event.target.value)} />
        </form>
        <form className="workspaceSearchForm" onSubmit={(event) => { event.preventDefault(); void startSearch(); }}>
          <label className="workspaceVisuallyHidden" htmlFor="workspace-file-search">{copy.searchFiles}</label>
          <input id="workspace-file-search" placeholder={copy.searchFiles} title={copy.recursiveSearch} value={query} onChange={(event) => {
            setQuery(event.target.value);
            if (!event.target.value) setSearchResults(null);
          }} />
          <button aria-label={searchId ? copy.stopSearch : copy.searchFiles} type="submit" disabled={!query.trim()}>
            <FilesIcon name={searchId ? "close" : "search"} />
          </button>
        </form>
        <button aria-label={copy.upload} className="workspaceFilesUploadButton" disabled={!fileSession} title={copy.upload} type="button" onClick={() => void upload()}><FilesIcon name="upload" /> <span>{copy.upload}</span></button>
        <details className="workspaceFilesMoreActions" ref={moreActionsRef}>
          <summary aria-label={ui.moreActions} title={ui.moreActions}><FilesIcon name="more" /></summary>
          <div aria-label={ui.moreActions} className="workspaceFilesMoreMenu" role="group">
          <button
            aria-label={treeCollapsed ? ui.showTree : ui.hideTree}
            aria-pressed={!treeCollapsed}
            title={treeCollapsed ? ui.showTree : ui.hideTree}
            type="button"
            onClick={() => setTreeCollapsed((value) => !value)}
          ><FilesIcon name="tree" /> <span>{ui.directoryTree}</span></button>
          <button
            aria-label={copy.followCwd}
            aria-pressed={followCwd}
            className="workspaceToggleButton"
            disabled={!canLocate}
            title={!canLocate ? copy.cwdUnavailable : copy.followCwd}
            type="button"
            onClick={() => { if (followCwd) onFollowCwdChange(false); else void locateTerminal(); }}
          ><FilesIcon name="locate" /> <span>{copy.followCwd}</span></button>
          <button
            aria-label={showHidden ? copy.hideHidden : copy.showHidden}
            aria-pressed={showHidden}
            className="workspaceToggleButton"
            title={showHidden ? copy.hideHidden : copy.showHidden}
            type="button"
            onClick={() => setShowHidden((value) => !value)}
          ><FilesIcon name={showHidden ? "eyeOff" : "eye"} /> <span>{showHidden ? copy.hideHidden : copy.showHidden}</span></button>
          <label className="workspaceFilesMoreSelect">
            <span>{copy.sortBy}</span>
            <select value={sortKey} onChange={(event) => setSortKey(event.target.value as SortKey)}>
              <option value="name">{copy.sortName}</option>
              <option value="type">{copy.sortType}</option>
              <option value="size">{copy.sortSize}</option>
              <option value="modified">{copy.sortModified}</option>
            </select>
          </label>
          <button aria-label={sortAscending ? copy.ascending : copy.descending} title={sortAscending ? copy.ascending : copy.descending} type="button" onClick={() => setSortAscending((value) => !value)}><FilesIcon name={sortAscending ? "sortAscending" : "sortDescending"} /><span>{sortAscending ? copy.ascending : copy.descending}</span></button>
          <button aria-label={copy.download} disabled={selectedEntries.length === 0} title={copy.download} type="button" onClick={() => void download()}><FilesIcon name="download" /><span>{copy.download}</span></button>
          <button aria-label={copy.newFolder} disabled={!fileSession || !page} title={copy.newFolder} type="button" onClick={() => askOperation("create-directory", null, page?.canonicalPath ?? null)}><FilesIcon name="folderPlus" /><span>{copy.newFolder}</span></button>
          </div>
        </details>
      </div>

      {!followCwd && activeTerminal?.hostAlias === selectedHostAlias ? <div className="workspaceInfoBar">{copy.followCwdPaused}</div> : null}
      {searchResults !== null ? <div className="workspaceSearchSummary">{searchScanned} {copy.scanned}{searchTruncated ? ` · ${copy.resultsTruncated}` : ""}</div> : null}
      {createdRecovery ? (
        <div className="workspaceRecoveryNotice" role="status">
          <span>{copy.recoveryReady}</span>
          <button type="button" onClick={onViewRecoveries}>{copy.viewRecovery}</button>
          <button aria-label={copy.close} type="button" onClick={() => setCreatedRecovery(null)}><FilesIcon name="close" /></button>
        </div>
      ) : null}

      <div
        className="workspaceFilesExplorer"
        ref={explorerRef}
        style={{ "--workspace-files-tree-width": `${treeWidth}px` } as CSSProperties}
      >
        {!treeCollapsed ? (
          <>
            <DirectoryTree
              copy={ui}
              currentPath={page?.canonicalPath ?? null}
              directoryEntriesByPath={visibleTreeDirectories}
              expandedPaths={expandedTreePaths}
              loadingPaths={loadingTreePaths}
              session={fileSession}
              onNavigate={(path) => { if (fileSession) void navigate(fileSession, path, { manual: true }); }}
              onToggle={(path) => void toggleTreePath(path)}
            />
            <button
              aria-label={ui.resizeDirectoryTree}
              aria-orientation="vertical"
              aria-valuemax={TREE_MAX_WIDTH}
              aria-valuemin={TREE_MIN_WIDTH}
              aria-valuenow={treeWidth}
              className="workspaceFilesTreeResizeHandle"
              role="separator"
              type="button"
              onKeyDown={handleTreeResizeKeyDown}
              onPointerDown={startTreeResize}
            />
          </>
        ) : null}
        <main className="workspaceFilesTablePane" aria-busy={loading}>
          <FileTable
            compact={compact}
            copy={copy}
            entries={paginatedEntries}
            focusedIndex={focusedIndex}
            locale={locale}
            selectedRefs={selectedRefs}
            sortAscending={sortAscending}
            sortKey={sortKey}
            ui={ui}
            onAskOperation={askOperation}
            onContextMenu={(entry, point) => setContextMenu({ entry, ...point })}
            onFocusedIndexChange={setFocusedIndex}
            onMove={(source, destination) => askOperation("move", source, destination.canonicalPath)}
            onOpenEntry={openEntry}
            onSelectEntry={selectEntry}
            onSelectPage={selectPage}
            onShowPreview={(entry) => void showPreview(entry)}
          />
          {!loading && filesError ? (
            <div className="workspaceEmptyState workspaceFileEmpty" role="alert">
              <p>{copy.filesUnavailable}</p>
              <button type="button" onClick={() => {
                retryRequestRef.current = { hostAlias: selectedHostAlias, path: failedPath };
                setConnectionAttempt((value) => value + 1);
              }}>{copy.retryLoad}</button>
            </div>
          ) : null}
          {!loading && !filesError && page !== null && entries.length === 0 ? <div className="workspaceEmptyState workspaceFileEmpty">{copy.emptyDirectory}</div> : null}
          {!loading && !filesError && page === null && !selectedHostAlias ? (
            <div className="workspaceEmptyState workspaceFileEmpty">
              <strong>{copy.localFiles}</strong>
              <p>{hosts.length === 0 ? copy.noHosts : copy.localFilesHint}</p>
            </div>
          ) : null}
          {loading ? <div className="workspacePaneState">{copy.loading}</div> : null}
          {page && !filesError ? (
            <footer className="workspaceFilesPagination">
              <span
                aria-label={`${entries.length} ${ui.loadedItems}; ${selectedEntries.length} ${ui.selected}`}
                className="workspaceFilesPaginationSummary"
                title={`${entries.length} ${ui.loadedItems}; ${selectedEntries.length} ${ui.selected}`}
              >
                <strong>{entries.length}</strong><small>{ui.loadedItems}</small><span aria-hidden="true"> · </span><strong>{selectedEntries.length}</strong><small>{ui.selected}</small>
              </span>
              <nav aria-label={ui.pagination}>
                <button aria-label={ui.previousPage} disabled={clientPage === 0} type="button" onClick={() => { setClientPage((value) => Math.max(0, value - 1)); setFocusedIndex(0); }}>‹</button>
                <span>{ui.page} {clientPage + 1} {ui.of} {clientPageCount}</span>
                <button aria-label={ui.nextPage} disabled={clientPage >= clientPageCount - 1} type="button" onClick={() => { setClientPage((value) => Math.min(clientPageCount - 1, value + 1)); setFocusedIndex(0); }}>›</button>
              </nav>
              <label><span className="workspaceVisuallyHidden">{ui.rowsPerPage}</span><select aria-label={ui.rowsPerPage} value={clientPageSize} onChange={(event) => setClientPageSize(Number(event.target.value))}><option value={25}>25</option><option value={50}>50</option><option value={100}>100</option></select></label>
              {page.nextCursor && searchResults === null ? <button className="workspaceLoadMore" disabled={loading} type="button" onClick={() => void loadMore()}>{copy.loadMore}</button> : null}
            </footer>
          ) : null}
        </main>
      </div>

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

      <FilePreviewDialog copy={copy} preview={preview} onClose={() => setPreview(null)} />
      <FileOperationDialog
        busy={operationBusy}
        copy={copy}
        nameValid={operationNameValid}
        pending={pendingOperation}
        preview={operationPreview}
        onCancel={() => { setPendingOperation(null); setOperationPreview(null); }}
        onConfirm={() => void confirmOperation()}
        onNameChange={(name) => setPendingOperation((current) => current ? { ...current, name } : current)}
        onPrepare={() => void prepareOperation()}
      />
    </section>
  );
}
