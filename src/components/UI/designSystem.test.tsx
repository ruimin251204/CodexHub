import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { ActionButton } from "./ActionButton";
import { DataTable } from "./DataTable";
import type { DataTableColumn, DataTableSort } from "./DataTable";
import { HostSelector } from "./HostSelector";
import { SearchBox } from "./SearchBox";
import { Tabs } from "./Tabs";

interface Row {
  id: string;
  name: string;
  size: string;
}

const rows: Row[] = [
  { id: "1", name: "alpha.txt", size: "1 KB" },
  { id: "2", name: "beta.log", size: "2 KB" }
];

const columns: DataTableColumn<Row>[] = [
  { id: "name", header: "Name", render: (row) => row.name, sortable: true, priority: "essential" },
  { id: "size", header: "Size", render: (row) => row.size }
];

function ControlsHarness() {
  const [host, setHost] = useState("host-1");
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState("terminal");
  return (
    <>
      <HostSelector
        ariaLabel="Select host"
        placeholder="Choose"
        value={host}
        onValueChange={setHost}
        latency="53ms"
        options={[
          { id: "host-1", label: "Host 1", description: "Primary", statusTone: "success" },
          { id: "host-2", label: "Host 2", description: "Backup", statusTone: "warning" }
        ]}
      />
      <SearchBox
        aria-label="Search workspace"
        placeholder="Search"
        value={query}
        onValueChange={setQuery}
        clearLabel="Clear search"
        shortcutLabel="⌘ K"
      />
      <Tabs
        ariaLabel="Workspace sections"
        activeId={tab}
        onActiveIdChange={setTab}
        items={[
          { id: "terminal", label: "Terminal" },
          { id: "files", label: "Files" },
          { id: "disabled", label: "Disabled", disabled: true }
        ]}
      />
      <output>{host}:{query}:{tab}</output>
    </>
  );
}

test("host selector, search box and tabs expose controlled interactions", async () => {
  const user = userEvent.setup();
  render(<ControlsHarness />);

  await user.selectOptions(screen.getByRole("combobox", { name: "Select host" }), "host-2");
  await user.type(screen.getByRole("searchbox", { name: "Search workspace" }), "logs");
  await user.click(screen.getByRole("tab", { name: "Files" }));
  expect(screen.getByText("host-2:logs:files")).toBeVisible();

  await user.click(screen.getByRole("button", { name: "Clear search" }));
  expect(screen.getByText("host-2::files")).toBeVisible();

  screen.getByRole("tab", { name: "Files" }).focus();
  await user.keyboard("{ArrowLeft}");
  expect(screen.getByRole("tab", { name: "Terminal" })).toHaveAttribute("aria-selected", "true");
});

test("data table supports sorting and controlled selection without activating a row", async () => {
  const user = userEvent.setup();
  const onSortChange = vi.fn<(sort: DataTableSort) => void>();
  const onSelectedKeysChange = vi.fn<(keys: Set<string>) => void>();
  const onRowActivate = vi.fn<(row: Row) => void>();

  render(
    <DataTable
      ariaLabel="Files"
      columns={columns}
      rows={rows}
      getRowKey={(row) => row.id}
      sort={{ columnId: "name", direction: "asc" }}
      onSortChange={onSortChange}
      selection={{
        selectedKeys: new Set<string>(),
        onSelectedKeysChange,
        getRowLabel: (row) => `Select ${row.name}`,
        selectAllLabel: "Select all"
      }}
      onRowActivate={onRowActivate}
    />
  );

  await user.click(screen.getByRole("button", { name: "Name" }));
  expect(onSortChange).toHaveBeenCalledWith({ columnId: "name", direction: "desc" });

  await user.click(screen.getByRole("checkbox", { name: "Select alpha.txt" }));
  expect(Array.from(onSelectedKeysChange.mock.calls[0][0])).toEqual(["1"]);
  expect(onRowActivate).not.toHaveBeenCalled();

  await user.click(screen.getByText("beta.log"));
  expect(onRowActivate).toHaveBeenCalledWith(rows[1]);
});

test("action button exposes loading state and disables repeated actions", () => {
  render(<ActionButton loading loadingLabel="Working">Save</ActionButton>);
  const button = screen.getByRole("button", { name: "Working" });
  expect(button).toBeDisabled();
  expect(button).toHaveAttribute("aria-busy", "true");
});
