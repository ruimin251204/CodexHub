export type TerminalIconName =
  | "terminal"
  | "split"
  | "expand"
  | "contract"
  | "reconnect"
  | "copy"
  | "theme"
  | "more"
  | "search"
  | "focus"
  | "plus"
  | "close"
  | "chevron";

export function TerminalIcon({ name, size = 16 }: { name: TerminalIconName; size?: number }) {
  const paths: Record<TerminalIconName, React.ReactNode> = {
    terminal: <><path d="m4 6 3 3-3 3" /><path d="M9 12h3" /></>,
    split: <><rect x="2.5" y="3" width="11" height="10" rx="1.5" /><path d="M8 3v10" /></>,
    expand: <><path d="M6 3H3v3" /><path d="m3 3 4 4" /><path d="M10 3h3v3" /><path d="m13 3-4 4" /><path d="M6 13H3v-3" /><path d="m3 13 4-4" /><path d="M10 13h3v-3" /><path d="m13 13-4-4" /></>,
    contract: <><path d="M7 7H3V3" /><path d="m3 3 4 4" /><path d="M9 7h4V3" /><path d="m13 3-4 4" /><path d="M7 9H3v4" /><path d="m3 13 4-4" /><path d="M9 9h4v4" /><path d="m13 13-4-4" /></>,
    reconnect: <><path d="M13 5V2l-1.8 1.8A5.5 5.5 0 1 0 13.3 10" /></>,
    copy: <><rect x="5" y="5" width="8" height="8" rx="1.5" /><path d="M3 10H2.5A1.5 1.5 0 0 1 1 8.5v-6A1.5 1.5 0 0 1 2.5 1h6A1.5 1.5 0 0 1 10 2.5V3" /></>,
    theme: <><circle cx="8" cy="8" r="3" /><path d="M8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.4 1.4M11.6 11.6 13 13M13 3l-1.4 1.4M4.4 11.6 3 13" /></>,
    more: <><circle cx="3" cy="8" r=".75" fill="currentColor" stroke="none" /><circle cx="8" cy="8" r=".75" fill="currentColor" stroke="none" /><circle cx="13" cy="8" r=".75" fill="currentColor" stroke="none" /></>,
    search: <><circle cx="7" cy="7" r="4.5" /><path d="m10.5 10.5 3 3" /></>,
    focus: <><path d="M6 2H2v4M10 2h4v4M6 14H2v-4M10 14h4v-4" /></>,
    plus: <path d="M8 3v10M3 8h10" />,
    close: <path d="m4 4 8 8M12 4l-8 8" />,
    chevron: <path d="m5 6 3 3 3-3" />
  };

  return (
    <svg
      aria-hidden="true"
      className="chTerminalIcon"
      fill="none"
      height={size}
      viewBox="0 0 16 16"
      width={size}
    >
      <g stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.35">
        {paths[name]}
      </g>
    </svg>
  );
}

