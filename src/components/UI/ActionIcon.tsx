export type ActionIconName =
  | "add"
  | "check"
  | "copy"
  | "download"
  | "refresh"
  | "scan"
  | "trash"
  | "update"
  | "upload";

export function ActionIcon({ name }: { name: ActionIconName }) {
  return (
    <svg className="pageActionIcon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {name === "add" ? <><path d="M12 5v14" /><path d="M5 12h14" /></> : null}
      {name === "check" ? <path d="m5.5 12.5 4 4 9-9" /> : null}
      {name === "copy" ? <><rect x="8" y="8" width="11" height="11" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></> : null}
      {name === "download" ? <><path d="M12 4.5v10" /><path d="m8.5 11 3.5 3.5 3.5-3.5" /><path d="M5.5 19h13" /></> : null}
      {name === "upload" ? <><path d="M12 19.5v-10" /><path d="m8.5 13 3.5-3.5 3.5 3.5" /><path d="M5.5 5h13" /></> : null}
      {name === "refresh" || name === "update" ? <><path d="M19 8.5A7 7 0 0 0 6.2 6.8L4.5 8.5" /><path d="M4.5 4.8v3.7h3.7" /><path d="M5 15.5a7 7 0 0 0 12.8 1.7l1.7-1.7" /><path d="M19.5 19.2v-3.7h-3.7" /></> : null}
      {name === "scan" ? <><circle cx="10.5" cy="10.5" r="5.5" /><path d="m15 15 4.5 4.5" /><path d="M10.5 7.5v3h3" /></> : null}
      {name === "trash" ? <><path d="M5.5 7h13" /><path d="M9 7V5h6v2" /><path d="M7.5 9.5 8.4 20h7.2l.9-10.5" /><path d="M10.5 11.5v5" /><path d="M13.5 11.5v5" /></> : null}
    </svg>
  );
}
