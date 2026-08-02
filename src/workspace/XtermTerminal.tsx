import { useEffect, useMemo, useRef, useState } from "react";
import "@xterm/xterm/css/xterm.css";
import type { WorkspaceCopy } from "./copy";
import { usePersonalInfoMasking } from "../ui/PersonalInfoMasking";
import type {
  TerminalOutputFrame,
  WorkspaceApi,
  WorkspaceTerminalPreferences,
  WorkspaceTerminalSession
} from "./types";

export const WORKSPACE_TERMINAL_SEARCH_EVENT = "codexhub:workspace-terminal-search";
export const WORKSPACE_TERMINAL_FOCUS_EVENT = "codexhub:workspace-terminal-focus";
export const WORKSPACE_TERMINAL_COPY_EVENT = "codexhub:workspace-terminal-copy";

/** Terminal color mode is deliberately independent from the surrounding app theme. */
export type TerminalThemeOverride = "preferences" | "dark" | "light" | "high-contrast";

/** Stable identifiers for a sanitized renderer-failure task. */
export type TerminalRendererFailure = {
  sessionId: string;
  generation: number;
  retry: number;
};

type XtermLike = {
  cols: number;
  rows: number;
  unicode: { activeVersion: string };
  options: {
    theme?: Record<string, string>;
    cursorStyle?: WorkspaceTerminalPreferences["cursorStyle"];
    fontFamily?: string;
    fontSize?: number;
    lineHeight?: number;
    screenReaderMode?: boolean;
    scrollback?: number;
  };
  loadAddon: (addon: unknown) => void;
  open: (element: HTMLElement) => void;
  focus: () => void;
  write: (data: Uint8Array | string, callback?: () => void) => void;
  writeln: (data: string) => void;
  dispose: () => void;
  hasSelection: () => boolean;
  getSelection: () => string;
  onData: (listener: (data: string) => void) => { dispose: () => void };
  attachCustomKeyEventHandler: (handler: (event: KeyboardEvent) => boolean) => void;
};

type FitAddonLike = { fit: () => void; dispose: () => void };
type SearchAddonLike = {
  findNext: (term: string, options?: { caseSensitive?: boolean; incremental?: boolean }) => boolean;
  findPrevious: (term: string, options?: { caseSensitive?: boolean }) => boolean;
  clearDecorations: () => void;
  dispose: () => void;
};

function base64ToBytes(value: string) {
  const binary = window.atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function utf8ToBase64(value: string) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x4000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x4000));
  }
  return window.btoa(binary);
}

function resolveFontFamily(preference: WorkspaceTerminalPreferences["fontFamily"]) {
  switch (preference) {
    case "cascadia": return '"Cascadia Mono", "Cascadia Code", monospace';
    case "jetbrains": return '"JetBrains Mono", monospace';
    case "sf-mono": return '"SF Mono", Menlo, Monaco, monospace';
    default: return 'var(--font-mono, "Consolas", "Cascadia Mono", "SF Mono", monospace)';
  }
}

function resolveTerminalThemeMode(
  preference: WorkspaceTerminalPreferences["colorScheme"],
  override: TerminalThemeOverride
): Exclude<TerminalThemeOverride, "preferences"> {
  if (override !== "preferences") return override;
  // Legacy follow-app preferences fall back to dark rather than reading app/system state.
  return preference === "light" || preference === "high-contrast" ? preference : "dark";
}

function resolveTerminalTheme(mode: Exclude<TerminalThemeOverride, "preferences">): Record<string, string> {
  if (mode === "high-contrast") {
    return {
      background: "#000000",
      foreground: "#ffffff",
      cursor: "#ffff00",
      selectionBackground: "#1aebff66",
      black: "#000000",
      brightBlack: "#a0a0a0",
      red: "#ff5f5f",
      green: "#5cff8d",
      yellow: "#ffe36e",
      blue: "#6db4ff",
      magenta: "#e29cff",
      cyan: "#72f1ff"
    };
  }
  return mode === "dark"
    ? {
        background: "#111417",
        foreground: "#d8dee9",
        cursor: "#f4f7fb",
        cursorAccent: "#111417",
        selectionBackground: "#4d8eff55",
        black: "#15191d",
        red: "#ff6b74",
        green: "#7bd88f",
        yellow: "#f3cf65",
        blue: "#6ca9ff",
        magenta: "#c792ea",
        cyan: "#64d8cb",
        white: "#d8dee9",
        brightBlack: "#68717d",
        brightWhite: "#ffffff"
      }
    : {
        background: "#fbfcfe",
        foreground: "#202938",
        cursor: "#202938",
        cursorAccent: "#fbfcfe",
        selectionBackground: "#2f6feb33",
        black: "#202938",
        red: "#cf3f4b",
        green: "#238636",
        yellow: "#9a6700",
        blue: "#0969da",
        magenta: "#8250df",
        cyan: "#1b7c83",
        white: "#d0d7de",
        brightBlack: "#57606a",
        brightWhite: "#ffffff"
      };
}

function isClipboardShortcut(event: KeyboardEvent, platform: "windows" | "macos" | "linux", key: "c" | "v") {
  if (event.key.toLowerCase() !== key || event.isComposing || event.getModifierState("AltGraph")) return false;
  return platform === "macos" ? event.metaKey && !event.ctrlKey : event.ctrlKey && event.shiftKey;
}

export function XtermTerminal({
  active,
  api,
  copy,
  platform,
  preferences,
  session,
  themeOverride = "preferences",
  onError,
  onRendererError
}: {
  active: boolean;
  api: WorkspaceApi;
  copy: WorkspaceCopy;
  platform: "windows" | "macos" | "linux";
  preferences: WorkspaceTerminalPreferences;
  session: WorkspaceTerminalSession;
  themeOverride?: TerminalThemeOverride;
  onError: (error: unknown) => void;
  onRendererError: (failure: TerminalRendererFailure) => void;
}) {
  const personalInfo = usePersonalInfoMasking();
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<XtermLike | null>(null);
  const fitAddonRef = useRef<FitAddonLike | null>(null);
  const searchAddonRef = useRef<SearchAddonLike | null>(null);
  const latestSequenceRef = useRef<number | null>(null);
  const pendingAckRef = useRef<number | null>(null);
  const ackTimerRef = useRef<number | null>(null);
  const attachInFlightRef = useRef(false);
  const generationRef = useRef(session.generation);
  const attachedGenerationRef = useRef<number | null>(null);
  const preferencesRef = useRef(preferences);
  const themeRef = useRef<Record<string, string>>({});
  const onErrorRef = useRef(onError);
  const onRendererErrorRef = useRef(onRendererError);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [rendererReady, setRendererReady] = useState(false);
  const [rendererRetry, setRendererRetry] = useState(0);
  const [pendingPaste, setPendingPaste] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchText, setSearchText] = useState("");

  generationRef.current = session.generation;
  preferencesRef.current = preferences;
  onErrorRef.current = onError;
  onRendererErrorRef.current = onRendererError;
  const resolvedThemeMode = useMemo(
    () => resolveTerminalThemeMode(preferences.colorScheme, themeOverride),
    [preferences.colorScheme, themeOverride]
  );
  const theme = useMemo(() => resolveTerminalTheme(resolvedThemeMode), [resolvedThemeMode]);
  themeRef.current = theme;

  useEffect(() => {
    let cancelled = false;
    let resizeObserver: ResizeObserver | null = null;
    let resizeTimer: number | null = null;
    const disposables: Array<{ dispose: () => void }> = [];
    let pendingTerminal: XtermLike | null = null;
    let pendingFitAddon: FitAddonLike | null = null;
    let pendingSearchAddon: SearchAddonLike | null = null;

    setLoading(true);
    setLoadError(false);

    void Promise.all([
      import("@xterm/xterm"),
      import("@xterm/addon-fit"),
      import("@xterm/addon-search"),
      import("@xterm/addon-unicode11")
    ]).then(([xtermModule, fitModule, searchModule, unicodeModule]) => {
      if (cancelled || !containerRef.current) return;
      const terminal = new xtermModule.Terminal({
        // Unicode11Addon needs this xterm API. Clipboard/WebLinks/OSC52 stay disabled.
        allowProposedApi: true,
        convertEol: false,
        cursorBlink: true,
        cursorStyle: preferencesRef.current.cursorStyle,
        disableStdin: false,
        drawBoldTextInBrightColors: true,
        fontFamily: resolveFontFamily(preferencesRef.current.fontFamily),
        fontSize: Math.min(24, Math.max(12, preferencesRef.current.fontSize)),
        lineHeight: preferencesRef.current.lineHeight,
        macOptionIsMeta: false,
        rightClickSelectsWord: false,
        screenReaderMode: preferencesRef.current.screenReaderMode,
        scrollback: preferencesRef.current.scrollback,
        smoothScrollDuration: 0,
        theme: themeRef.current,
      }) as unknown as XtermLike;
      pendingTerminal = terminal;
      const fitAddon = new fitModule.FitAddon() as unknown as FitAddonLike;
      const searchAddon = new searchModule.SearchAddon() as unknown as SearchAddonLike;
      pendingFitAddon = fitAddon;
      pendingSearchAddon = searchAddon;
      try {
        const unicodeAddon = new unicodeModule.Unicode11Addon();
        terminal.loadAddon(fitAddon);
        terminal.loadAddon(searchAddon);
        terminal.loadAddon(unicodeAddon);
        terminal.unicode.activeVersion = "11";
        terminal.open(containerRef.current);
      } catch (error) {
        // Initialization may allocate resources before refs are assigned.
        pendingSearchAddon?.dispose();
        pendingFitAddon?.dispose();
        pendingTerminal?.dispose();
        pendingSearchAddon = null;
        pendingFitAddon = null;
        pendingTerminal = null;
        throw error;
      }
      terminalRef.current = terminal;
      fitAddonRef.current = fitAddon;
      searchAddonRef.current = searchAddon;
      pendingSearchAddon = null;
      pendingFitAddon = null;
      pendingTerminal = null;
      setLoading(false);
      setLoadError(false);
      setRendererReady(true);

      const sendInput = (data: string) => {
        if (preferencesRef.current.confirmLargePaste && (data.includes("\n") || new TextEncoder().encode(data).byteLength > 4096)) {
          setPendingPaste(data);
          return;
        }
        void api.writeTerminal({
          sessionId: session.sessionId,
          generation: generationRef.current,
          dataBase64: utf8ToBase64(data)
        }).catch((error) => onErrorRef.current(error));
      };

      terminal.attachCustomKeyEventHandler((event) => {
        if (event.isComposing || event.getModifierState("AltGraph")) return true;
        if (isClipboardShortcut(event, platform, "c") && terminal.hasSelection()) {
          void navigator.clipboard.writeText(terminal.getSelection()).catch((error) => onErrorRef.current(error));
          return false;
        }
        if (isClipboardShortcut(event, platform, "v")) {
          void navigator.clipboard.readText().then(sendInput).catch((error) => onErrorRef.current(error));
          return false;
        }
        // Ctrl+C remains untouched so xterm sends ETX to the remote PTY.
        if (platform === "macos" && event.metaKey && event.key.toLowerCase() === "q") return true;
        return true;
      });
      disposables.push(terminal.onData(sendInput));

      const fitAndResize = () => {
        if (cancelled || !terminalRef.current) return;
        fitAddon.fit();
        const columns = Math.min(500, Math.max(2, terminal.cols));
        const rows = Math.min(300, Math.max(1, terminal.rows));
        if (resizeTimer !== null) window.clearTimeout(resizeTimer);
        resizeTimer = window.setTimeout(() => {
          void api.resizeTerminal({
            sessionId: session.sessionId,
            generation: generationRef.current,
            columns,
            rows
          }).catch((error) => onErrorRef.current(error));
        }, 80);
      };
      resizeObserver = new ResizeObserver(fitAndResize);
      resizeObserver.observe(containerRef.current);
      fitAndResize();
      if (active) terminal.focus();
    }).catch(() => {
      if (cancelled) return;
      setLoading(false);
      setLoadError(true);
      // Persist a fixed summary only; the raw browser exception can contain
      // paths, extension data or rendered terminal text.
      onRendererErrorRef.current({
        sessionId: session.sessionId,
        generation: generationRef.current,
        retry: rendererRetry
      });
    });

    return () => {
      cancelled = true;
      resizeObserver?.disconnect();
      if (resizeTimer !== null) window.clearTimeout(resizeTimer);
      for (const disposable of disposables) disposable.dispose();
      pendingSearchAddon?.dispose();
      pendingFitAddon?.dispose();
      pendingTerminal?.dispose();
      fitAddonRef.current?.dispose();
      searchAddonRef.current?.dispose();
      terminalRef.current?.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
      searchAddonRef.current = null;
      setRendererReady(false);
    };
    // Renderer lifecycle is independent from the PTY.  Bytes remain in refs.
  }, [api, platform, rendererRetry, session.sessionId]);

  useEffect(() => {
    if (!terminalRef.current) return;
    terminalRef.current.options.theme = theme;
    terminalRef.current.options.cursorStyle = preferences.cursorStyle;
    terminalRef.current.options.fontFamily = resolveFontFamily(preferences.fontFamily);
    terminalRef.current.options.fontSize = Math.min(24, Math.max(12, preferences.fontSize));
    terminalRef.current.options.lineHeight = preferences.lineHeight;
    terminalRef.current.options.screenReaderMode = preferences.screenReaderMode;
    terminalRef.current.options.scrollback = preferences.scrollback;
  }, [preferences, theme]);

  useEffect(() => {
    if (active) terminalRef.current?.focus();
  }, [active]);

  useEffect(() => {
    if (attachedGenerationRef.current !== session.generation) {
      attachedGenerationRef.current = session.generation;
      latestSequenceRef.current = null;
      pendingAckRef.current = null;
    }
    if (!rendererReady) return;
    let disposed = false;
    let unsubscribe: () => void = () => undefined;

    const scheduleAck = (frame: TerminalOutputFrame) => {
      pendingAckRef.current = frame.sequence;
      if (ackTimerRef.current !== null) return;
      ackTimerRef.current = window.setTimeout(() => {
        ackTimerRef.current = null;
        const sequence = pendingAckRef.current;
        if (sequence === null) return;
        void api.ackTerminal({
          sessionId: session.sessionId,
          generation: generationRef.current,
          sequence
        }).catch(onError);
      }, 100);
    };

    const renderFrames = (frames: TerminalOutputFrame[]) => {
      const terminal = terminalRef.current;
      if (!terminal) return;
      for (const frame of frames.slice().sort((left, right) => left.sequence - right.sequence)) {
        if (frame.generation !== generationRef.current) continue;
        if (latestSequenceRef.current !== null && frame.sequence <= latestSequenceRef.current) continue;
        try {
          terminal.write(base64ToBytes(frame.dataBase64), () => scheduleAck(frame));
        } catch (error) {
          onErrorRef.current(error);
          continue;
        }
        latestSequenceRef.current = frame.sequence;
      }
    };

    const attach = async () => {
      if (attachInFlightRef.current) return;
      attachInFlightRef.current = true;
      try {
        const attachment = await api.attachTerminal({
          sessionId: session.sessionId,
          generation: generationRef.current,
          afterSequence: latestSequenceRef.current
        });
        if (disposed || attachment.session.generation !== generationRef.current) return;
        if (attachment.truncated) terminalRef.current?.writeln("\r\n[CodexHub: buffered output was truncated]\r\n");
        renderFrames(attachment.frames);
      } catch (error) {
        if (!disposed) onErrorRef.current(error);
      } finally {
        attachInFlightRef.current = false;
      }
    };

    const acceptFrame = (frame: TerminalOutputFrame) => {
      if (frame.sessionId !== session.sessionId || frame.generation !== generationRef.current) return;
      const latest = latestSequenceRef.current;
      if (latest !== null && frame.sequence > latest + 1) {
        void attach();
        return;
      }
      renderFrames([frame]);
    };

    void Promise.resolve(api.events.onTerminalOutput(acceptFrame)).then((stop) => {
      if (disposed) stop();
      else unsubscribe = stop;
    }).catch((error) => onErrorRef.current(error));
    void attach();
    return () => {
      disposed = true;
      unsubscribe();
      if (ackTimerRef.current !== null) window.clearTimeout(ackTimerRef.current);
      ackTimerRef.current = null;
    };
  }, [api, rendererReady, session.generation, session.sessionId]);

  useEffect(() => {
    const onSearch = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId: string }>).detail;
      if (detail?.sessionId !== session.sessionId) return;
      setSearchOpen(true);
    };
    const onFocus = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId: string }>).detail;
      if (detail?.sessionId === session.sessionId) terminalRef.current?.focus();
    };
    const onCopy = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId: string }>).detail;
      const terminal = terminalRef.current;
      if (detail?.sessionId !== session.sessionId || !terminal) return;
      if (!terminal.hasSelection()) {
        terminal.focus();
        return;
      }
      void navigator.clipboard.writeText(terminal.getSelection())
        .then(() => terminal.focus())
        .catch((error) => onErrorRef.current(error));
    };
    document.addEventListener(WORKSPACE_TERMINAL_SEARCH_EVENT, onSearch);
    document.addEventListener(WORKSPACE_TERMINAL_FOCUS_EVENT, onFocus);
    document.addEventListener(WORKSPACE_TERMINAL_COPY_EVENT, onCopy);
    return () => {
      document.removeEventListener(WORKSPACE_TERMINAL_SEARCH_EVENT, onSearch);
      document.removeEventListener(WORKSPACE_TERMINAL_FOCUS_EVENT, onFocus);
      document.removeEventListener(WORKSPACE_TERMINAL_COPY_EVENT, onCopy);
    };
  }, [session.sessionId]);

  const submitPaste = () => {
    if (pendingPaste === null) return;
    const data = pendingPaste;
    setPendingPaste(null);
    void api.writeTerminal({
      sessionId: session.sessionId,
      generation: generationRef.current,
      dataBase64: utf8ToBase64(data)
    }).catch((error) => onErrorRef.current(error));
    terminalRef.current?.focus();
  };

  return (
    <div className="workspaceXterm" data-active={active} data-terminal-theme={resolvedThemeMode}>
      {searchOpen ? (
        <form className="workspaceTerminalSearch" onSubmit={(event) => {
          event.preventDefault();
          searchAddonRef.current?.findNext(searchText, { incremental: true });
        }}>
          <label className="workspaceVisuallyHidden" htmlFor={`terminal-search-${session.sessionId}`}>{copy.searchTerminal}</label>
          <input
            autoFocus
            id={`terminal-search-${session.sessionId}`}
            placeholder={copy.searchPlaceholder}
            value={searchText}
            onChange={(event) => {
              setSearchText(event.target.value);
              searchAddonRef.current?.findNext(event.target.value, { incremental: true });
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setSearchOpen(false);
                searchAddonRef.current?.clearDecorations();
                terminalRef.current?.focus();
              }
            }}
          />
          <button aria-label={copy.previousMatch} title={copy.previousMatch} type="button" onClick={() => searchAddonRef.current?.findPrevious(searchText)}>↑</button>
          <button aria-label={copy.nextMatch} title={copy.nextMatch} type="submit">↓</button>
          <button aria-label={copy.closeSearch} title={copy.closeSearch} type="button" onClick={() => {
            setSearchOpen(false);
            searchAddonRef.current?.clearDecorations();
            terminalRef.current?.focus();
          }}>×</button>
        </form>
      ) : null}
      <div ref={containerRef} className="workspaceXtermCanvas" aria-label={personalInfo.maskText(`${session.title} — ${session.hostAlias}`)} />
      {loading ? <div className="workspacePaneState">{copy.loading}</div> : null}
      {loadError ? <div className="workspacePaneState workspacePaneError" role="alert">{copy.terminalUnavailable}</div> : null}
      {loadError ? <button className="workspaceRendererRetry" type="button" onClick={() => setRendererRetry((value) => value + 1)}>{copy.retryLoad}</button> : null}
      {pendingPaste !== null ? (
        <div className="workspaceInlineDialogBackdrop" role="presentation">
          <section aria-describedby={`paste-body-${session.sessionId}`} aria-labelledby={`paste-title-${session.sessionId}`} className="workspaceInlineDialog" role="alertdialog" aria-modal="true">
            <h3 id={`paste-title-${session.sessionId}`}>{copy.pasteTitle}</h3>
            <p id={`paste-body-${session.sessionId}`}>{copy.pasteBody}</p>
            <div className="workspaceDialogActions">
              <button type="button" onClick={() => { setPendingPaste(null); terminalRef.current?.focus(); }}>{copy.cancel}</button>
              <button className="workspacePrimaryButton" type="button" onClick={submitPaste}>{copy.sendPaste}</button>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
