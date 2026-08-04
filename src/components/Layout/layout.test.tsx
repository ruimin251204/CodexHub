import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { AppShell } from "./AppShell";
import { Header } from "./Header";
import { PageContainer } from "./PageContainer";
import { Sidebar } from "./Sidebar";

function LayoutHarness() {
  const [collapsed, setCollapsed] = useState(false);
  const [active, setActive] = useState("terminal");
  const sidebar = (
    <Sidebar
      ariaLabel="Primary"
      collapsed={collapsed}
      onCollapsedChange={setCollapsed}
      activeItemId={active}
      onItemSelect={setActive}
      collapseLabel="Collapse sidebar"
      expandLabel="Expand sidebar"
      footer={(
        <>
          <button type="button">Settings</button>
          <button type="button">Update</button>
        </>
      )}
      groups={[
        {
          id: "home",
          items: [{ id: "dashboard", label: "Home", icon: "H" }]
        },
        {
          id: "workspace",
          label: "Workspace",
          items: [
            { id: "terminal", label: "Terminal", icon: "T" },
            { id: "files", label: "Files", icon: "F", indicator: { tone: "success", label: "Ready" } }
          ]
        }
      ]}
    />
  );

  return (
    <AppShell
      header={<Header brand="CodexHub" search={<input aria-label="Global search" />} />}
      sidebar={sidebar}
      sidebarCollapsed={collapsed}
      mainLabel="Application content"
    >
      <PageContainer title="Terminal" description="Remote session" actions={<button>New session</button>}>
        <div>Active: {active}</div>
      </PageContainer>
    </AppShell>
  );
}

test("layout keeps navigation and collapse state controlled", async () => {
  const user = userEvent.setup();
  const { container } = render(<LayoutHarness />);

  expect(screen.getByRole("button", { name: "Terminal" })).toHaveAttribute("aria-current", "page");
  await user.click(screen.getByRole("button", { name: "Files. Ready" }));
  expect(screen.getByText("Active: files")).toBeVisible();
  expect(screen.getByRole("button", { name: "Files. Ready" })).toHaveAttribute("aria-current", "page");

  await user.click(screen.getByRole("button", { name: "Collapse sidebar" }));
  expect(container.querySelector(".ch-app-shell")).toHaveAttribute("data-sidebar-collapsed", "true");
  expect(screen.getByRole("button", { name: "Expand sidebar" })).toHaveAttribute("aria-expanded", "false");
});

test("sidebar keeps settings and update before the trailing collapse control", () => {
  const { container } = render(<LayoutHarness />);
  const labels = Array.from(container.querySelectorAll(".ch-sidebar__bottom button"))
    .map((button) => button.getAttribute("aria-label") ?? button.textContent?.trim());

  expect(labels).toEqual(["Settings", "Update", "Collapse sidebar"]);
});

test("sidebar keeps home in a standalone group before workspace", () => {
  const { container } = render(<LayoutHarness />);
  const groups = Array.from(container.querySelectorAll(".ch-sidebar__group"));

  expect(groups.map((group) => group.getAttribute("data-group"))).toEqual(["home", "workspace"]);
  expect(groups[0]?.querySelector(".ch-sidebar__group-label")).not.toBeInTheDocument();
  expect(groups[1]?.querySelector(".ch-sidebar__group-label")).toHaveTextContent("Workspace");
});

test("app shell can omit the secondary header row", () => {
  const { container } = render(
    <AppShell sidebar={<aside>Navigation</aside>} mainLabel="Content">
      <div>Details</div>
    </AppShell>
  );

  expect(container.querySelector(".ch-app-shell")).toHaveAttribute("data-has-header", "false");
  expect(container.querySelector(".ch-app-shell__header")).not.toBeInTheDocument();
});

test("responsive icon sidebar keeps its navigation names and tooltips aligned", () => {
  const originalMatchMedia = window.matchMedia;
  const matchMedia = () => ({
    matches: true,
    media: "(max-width: 820px)",
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false
  }) as MediaQueryList;
  Object.defineProperty(window, "matchMedia", { configurable: true, value: matchMedia });

  try {
    const { container } = render(<LayoutHarness />);

    expect(container.querySelector(".ch-sidebar")).toHaveAttribute("data-forced-compact", "true");
    expect(screen.getByRole("button", { name: "Terminal" })).toHaveAttribute("title", "Terminal");
    expect(screen.getByRole("button", { name: "Files. Ready" })).toHaveAttribute("title", "Files. Ready");
    expect(screen.queryByRole("button", { name: "Collapse sidebar" })).not.toBeInTheDocument();
  } finally {
    Object.defineProperty(window, "matchMedia", { configurable: true, value: originalMatchMedia });
  }
});

test("page container creates a labelled section", () => {
  render(<PageContainer title="Transfers"><div>Queue</div></PageContainer>);
  expect(screen.getByRole("region", { name: "Transfers" })).toBeVisible();
});
