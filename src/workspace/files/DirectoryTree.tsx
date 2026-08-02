import { useMemo } from "react";
import type { CSSProperties } from "react";
import type { RemoteFileEntry, WorkspaceFilesSession } from "../types";
import type { FilesUiCopy } from "./filesUiCopy";
import { FileGlyph } from "./FileGlyph";
import { FilesIcon } from "./FilesIcon";

type TreeNode = { name: string; path: string };

function pathSegments(path: string) {
  const normalized = path === "/" ? "/" : `/${path.split("/").filter(Boolean).join("/")}`;
  const nodes: TreeNode[] = [{ name: "/", path: "/" }];
  if (normalized === "/") return nodes;
  let cursor = "";
  for (const segment of normalized.slice(1).split("/")) {
    cursor += `/${segment}`;
    nodes.push({ name: segment, path: cursor });
  }
  return nodes;
}

function buildTreeChildren(
  session: WorkspaceFilesSession,
  currentPath: string | null,
  directoryEntriesByPath: ReadonlyMap<string, RemoteFileEntry[]>
) {
  const children = new Map<string, TreeNode[]>();
  const mergeChild = (parent: string, node: TreeNode) => {
    const current = children.get(parent) ?? [];
    if (!current.some((candidate) => candidate.path === node.path)) {
      children.set(parent, [...current, node].sort((a, b) => a.name.localeCompare(b.name)));
    }
  };

  // Session and canonical page paths are authoritative, so their ancestry can
  // safely keep the active location visible before a parent is lazily listed.
  for (const path of [session.homePath, currentPath].filter((value): value is string => Boolean(value))) {
    const chain = pathSegments(path);
    for (let index = 1; index < chain.length; index += 1) {
      mergeChild(chain[index - 1].path, chain[index]);
    }
  }
  for (const [path, entries] of directoryEntriesByPath) {
    for (const entry of entries) mergeChild(path, { name: entry.name, path: entry.canonicalPath });
  }
  return children;
}

function TreeBranch({
  copy,
  currentPath,
  depth,
  expandedPaths,
  loadingPaths,
  node,
  treeChildren,
  onNavigate,
  onToggle
}: {
  copy: FilesUiCopy;
  currentPath: string | null;
  depth: number;
  expandedPaths: ReadonlySet<string>;
  loadingPaths: ReadonlySet<string>;
  node: TreeNode;
  treeChildren: ReadonlyMap<string, TreeNode[]>;
  onNavigate: (path: string) => void;
  onToggle: (path: string) => void;
}) {
  const expanded = expandedPaths.has(node.path);
  const children = treeChildren.get(node.path) ?? [];
  const label = node.path === "/" ? copy.rootDirectory : node.name;
  return (
    <li role="treeitem" aria-expanded={expanded} aria-current={currentPath === node.path ? "page" : undefined}>
      <div className="workspaceDirectoryTreeRow" data-active={currentPath === node.path} style={{ "--tree-depth": depth } as CSSProperties}>
        <button
          aria-label={`${expanded ? copy.collapseDirectory : copy.expandDirectory}: ${label}`}
          className="workspaceDirectoryChevron"
          data-loading={loadingPaths.has(node.path)}
          type="button"
          onClick={() => onToggle(node.path)}
        >{loadingPaths.has(node.path) ? "·" : <FilesIcon name={expanded ? "chevronDown" : "chevronRight"} />}</button>
        <button className="workspaceDirectoryName" title={node.path} type="button" onClick={() => onNavigate(node.path)}>
          <FileGlyph kind="directory" />
          <span>{label}</span>
        </button>
      </div>
      {expanded && children.length > 0 ? (
        <ul role="group">
          {children.map((child) => (
            <TreeBranch
              copy={copy}
              currentPath={currentPath}
              depth={depth + 1}
              expandedPaths={expandedPaths}
              key={child.path}
              loadingPaths={loadingPaths}
              node={child}
              treeChildren={treeChildren}
              onNavigate={onNavigate}
              onToggle={onToggle}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export function DirectoryTree({
  copy,
  currentPath,
  directoryEntriesByPath,
  expandedPaths,
  loadingPaths,
  session,
  onNavigate,
  onToggle
}: {
  copy: FilesUiCopy;
  currentPath: string | null;
  directoryEntriesByPath: ReadonlyMap<string, RemoteFileEntry[]>;
  expandedPaths: ReadonlySet<string>;
  loadingPaths: ReadonlySet<string>;
  session: WorkspaceFilesSession | null;
  onNavigate: (path: string) => void;
  onToggle: (path: string) => void;
}) {
  const treeChildren = useMemo(
    () => session ? buildTreeChildren(session, currentPath, directoryEntriesByPath) : new Map<string, TreeNode[]>(),
    [currentPath, directoryEntriesByPath, session]
  );

  return (
    <aside aria-label={copy.directoryTree} className="workspaceFilesTree">
      <header className="workspaceFilesSideHeader"><strong>{copy.directoryTree}</strong></header>
      <div className="workspaceFilesTreeScroll">
        {session ? (
          <ul aria-label={copy.directoryTree} className="workspaceDirectoryTree" role="tree">
            <TreeBranch
              copy={copy}
              currentPath={currentPath}
              depth={0}
              expandedPaths={expandedPaths}
              loadingPaths={loadingPaths}
              node={{ name: "/", path: "/" }}
              treeChildren={treeChildren}
              onNavigate={onNavigate}
              onToggle={onToggle}
            />
          </ul>
        ) : null}
        {session ? (
          <section className="workspaceFilesQuickAccess">
            <h3>{copy.quickAccess}</h3>
            <button type="button" onClick={() => onNavigate(session.homePath)}><FilesIcon name="home" />{copy.homeDirectory}</button>
            {currentPath ? <button type="button" onClick={() => onNavigate(currentPath)}><FilesIcon name="current" />{copy.currentDirectory}</button> : null}
          </section>
        ) : null}
      </div>
    </aside>
  );
}
