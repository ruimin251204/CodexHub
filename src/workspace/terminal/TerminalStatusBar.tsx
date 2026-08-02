import { useEffect, useState } from "react";
import type { WorkspaceTerminalSession } from "../types";
import type { TerminalUiCopy } from "./copy";

export function formatSessionDuration(createdAt: string, now = Date.now()) {
  const startedAt = Date.parse(createdAt);
  if (!Number.isFinite(startedAt)) return "--:--:--";
  const totalSeconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds].map((value) => String(value).padStart(2, "0")).join(":");
}

function useSessionDuration(createdAt: string) {
  const [duration, setDuration] = useState(() => formatSessionDuration(createdAt));

  useEffect(() => {
    setDuration(formatSessionDuration(createdAt));
    const timer = window.setInterval(() => setDuration(formatSessionDuration(createdAt)), 1000);
    return () => window.clearInterval(timer);
  }, [createdAt]);

  return duration;
}

export function TerminalStatusBar({
  copy,
  session
}: {
  copy: TerminalUiCopy;
  session: WorkspaceTerminalSession;
}) {
  const duration = useSessionDuration(session.createdAt);

  return (
    <footer className="chTerminalStatusBar">
      <div className="chTerminalStatusGroup">
        <span className="chTerminalStateDot" data-state={session.state} aria-hidden="true" />
        <strong>{copy.states[session.state]}</strong>
        <span>{copy.protocol}</span>
      </div>
      <div className="chTerminalStatusGroup">
        <span>{copy.sessionDuration}</span>
        <strong className="chTerminalStatusMono">{duration}</strong>
      </div>
      <div className="chTerminalStatusGroup chTerminalRendererStatus">
        <span className="chTerminalEncodingDot" aria-hidden="true" />
        <strong>{copy.renderer}</strong>
      </div>
    </footer>
  );
}

