import type { GlobalSearchEntry } from "./globalSearch";

export type SearchSectionId =
  | "dashboard"
  | "hosts"
  | "terminal"
  | "files"
  | "transfers"
  | "profiles"
  | "skills"
  | "monitor"
  | "tasks"
  | "settings";

type SettingsSearchCopyKey =
  | "appearance"
  | "theme"
  | "platformAppearance"
  | "font"
  | "settingsBehavior"
  | "sidebarCompletionIndicators"
  | "hostOperationLogPopups"
  | "personalInfoMasking"
  | "workspaceTerminal"
  | "terminalFontFamily"
  | "terminalColorScheme"
  | "terminalFontSize"
  | "terminalLineHeight"
  | "terminalScrollback"
  | "terminalCursor"
  | "terminalScreenReader"
  | "terminalConfirmLargePaste"
  | "localSsh"
  | "publicKey"
  | "appUpdates"
  | "closeButton"
  | "closeButtonBehavior"
  | "networkProxy"
  | "launchAtLogin";

type SettingsSearchAliasId =
  | "appearance"
  | "theme"
  | "platform"
  | "font"
  | "applicationBehavior"
  | "sidebarIndicators"
  | "logPopups"
  | "privacy"
  | "terminal"
  | "terminalFont"
  | "terminalColors"
  | "terminalFontSize"
  | "terminalLineHeight"
  | "terminalScrollback"
  | "terminalCursor"
  | "terminalScreenReader"
  | "terminalPaste"
  | "ssh"
  | "publicKey"
  | "updates"
  | "closeBehavior"
  | "proxy"
  | "launchAtLogin";

export type GlobalSearchCatalogCopy = {
  navItems: readonly { id: SearchSectionId; label: string }[];
  sections: Record<SearchSectionId, { body: string; title: string }>;
  settings: Record<SettingsSearchCopyKey, string>;
};

export type CodexHubSearchEntry = GlobalSearchEntry & {
  section: SearchSectionId;
  hostAlias?: string;
};

/** 双语搜索别名单独注册，确保语言边界检查和跨语言搜索都可维护。 */
export const globalSearchAliasesCopy = {
  sections: {
    dashboard: ["home", "dashboard", "overview", "主页", "首页", "概览"],
    hosts: ["host", "hosts", "server", "servers", "ssh", "主机", "服务器"],
    terminal: ["terminal", "shell", "console", "command", "ssh terminal", "终端", "命令", "控制台"],
    files: ["file", "files", "sftp", "folder", "directory", "文件", "文件夹", "目录"],
    transfers: ["transfer", "transfers", "upload", "download", "queue", "传输", "上传", "下载", "队列"],
    profiles: [
      "api", "api config", "api配置", "api key", "provider", "profile", "profiles", "configuration", "config", "endpoint",
      "接口", "密钥", "提供商", "配置", "配置文件", "模型配置"
    ],
    skills: ["skill", "skills", "skill pack", "plugin", "plugins", "extension", "技能", "技能库", "技能包", "插件", "扩展"],
    monitor: ["monitor", "resource", "cpu", "memory", "gpu", "监控", "资源", "显卡", "内存"],
    tasks: ["task", "tasks", "job", "jobs", "history", "log", "任务", "历史", "日志"],
    settings: ["setting", "settings", "preference", "preferences", "option", "设置", "偏好", "选项"]
  },
  settings: {
    appearance: ["appearance", "interface", "外观", "界面"],
    theme: ["theme", "system theme", "dark", "light", "主题", "系统主题", "深色", "浅色"],
    platform: ["platform", "windows", "macos", "mac", "平台", "系统风格", "外观平台"],
    font: ["font", "typeface", "ui font", "字体", "界面字体"],
    applicationBehavior: ["application behavior", "behavior", "应用行为", "行为"],
    sidebarIndicators: ["sidebar indicator", "completion", "侧栏提示", "完成提示"],
    logPopups: ["log popup", "host log", "日志弹窗", "主机日志"],
    privacy: ["privacy", "mask", "personal information", "隐私", "脱敏", "个人信息"],
    terminal: ["terminal settings", "workspace terminal", "终端设置", "工作台终端"],
    terminalFont: ["terminal font", "monospace", "终端字体", "等宽字体"],
    terminalColors: ["terminal theme", "color scheme", "high contrast", "终端主题", "配色", "高对比度"],
    terminalFontSize: ["font size", "text size", "字号", "终端字号"],
    terminalLineHeight: ["line height", "spacing", "行高", "行距"],
    terminalScrollback: ["scrollback", "history lines", "回滚行数", "历史行数"],
    terminalCursor: ["cursor", "block", "underline", "光标", "方块", "下划线"],
    terminalScreenReader: ["screen reader", "accessibility", "读屏", "屏幕阅读", "无障碍"],
    terminalPaste: ["large paste", "paste confirmation", "大粘贴", "粘贴确认"],
    ssh: ["ssh key", "ed25519", "local key", "ssh 密钥", "本地密钥", "私钥", "公钥"],
    publicKey: ["public key", "copy key", "公钥", "复制公钥"],
    updates: ["update", "updates", "version", "upgrade", "更新", "版本", "升级"],
    closeBehavior: ["close button", "quit", "minimize to tray", "关闭按钮", "退出", "最小化到托盘"],
    proxy: ["proxy", "network", "http proxy", "代理", "网络代理", "网络"],
    launchAtLogin: ["launch at login", "startup", "autostart", "boot", "开机自启", "自动启动", "启动项"]
  },
  hosts: ["host", "server", "ssh", "主机", "服务器"]
} as const satisfies {
  sections: Record<SearchSectionId, readonly string[]>;
  settings: Record<SettingsSearchAliasId, readonly string[]>;
  hosts: readonly string[];
};

export const hostSearchAliasesCopy = globalSearchAliasesCopy.hosts;

/** 构建稳定的双语页面与设置项目录；动态主机由 App 在运行时追加。 */
export function createGlobalSearchCatalog(copy: GlobalSearchCatalogCopy): CodexHubSearchEntry[] {
  const settingsPage = copy.navItems.find((item) => item.id === "settings")?.label ?? copy.sections.settings.title;
  const settingDetail = (group: string) => `${settingsPage} · ${group}`;
  const settingEntry = (
    id: string,
    label: string,
    group: string,
    targetId: string,
    keywords: readonly string[],
    priority = 20
  ): CodexHubSearchEntry => ({
    id: `setting:${id}`,
    label,
    detail: settingDetail(group),
    section: "settings",
    targetId,
    keywords,
    priority
  });

  const pages: CodexHubSearchEntry[] = copy.navItems.map((item) => ({
    id: `section:${item.id}`,
    label: item.label,
    detail: copy.sections[item.id].body,
    section: item.id,
    keywords: globalSearchAliasesCopy.sections[item.id],
    priority: 10
  }));

  return [...pages,
    settingEntry("appearance", copy.settings.appearance, copy.settings.appearance, "settings-appearance", globalSearchAliasesCopy.settings.appearance, 30),
    settingEntry("theme", copy.settings.theme, copy.settings.appearance, "settings-theme", globalSearchAliasesCopy.settings.theme, 40),
    settingEntry("platform", copy.settings.platformAppearance, copy.settings.appearance, "settings-platform", globalSearchAliasesCopy.settings.platform),
    settingEntry("font", copy.settings.font, copy.settings.appearance, "settings-font", globalSearchAliasesCopy.settings.font, 40),
    settingEntry("application-behavior", copy.settings.settingsBehavior, copy.settings.appearance, "settings-application-behavior", globalSearchAliasesCopy.settings.applicationBehavior),
    settingEntry("sidebar-indicators", copy.settings.sidebarCompletionIndicators, copy.settings.settingsBehavior, "settings-sidebar-indicators", globalSearchAliasesCopy.settings.sidebarIndicators),
    settingEntry("log-popups", copy.settings.hostOperationLogPopups, copy.settings.settingsBehavior, "settings-log-popups", globalSearchAliasesCopy.settings.logPopups),
    settingEntry("privacy", copy.settings.personalInfoMasking, copy.settings.settingsBehavior, "settings-privacy", globalSearchAliasesCopy.settings.privacy),
    settingEntry("terminal", copy.settings.workspaceTerminal, copy.settings.workspaceTerminal, "settings-terminal", globalSearchAliasesCopy.settings.terminal, 30),
    settingEntry("terminal-font", copy.settings.terminalFontFamily, copy.settings.workspaceTerminal, "settings-terminal-font", globalSearchAliasesCopy.settings.terminalFont),
    settingEntry("terminal-colors", copy.settings.terminalColorScheme, copy.settings.workspaceTerminal, "settings-terminal-colors", globalSearchAliasesCopy.settings.terminalColors),
    settingEntry("terminal-font-size", copy.settings.terminalFontSize, copy.settings.workspaceTerminal, "settings-terminal-font-size", globalSearchAliasesCopy.settings.terminalFontSize),
    settingEntry("terminal-line-height", copy.settings.terminalLineHeight, copy.settings.workspaceTerminal, "settings-terminal-line-height", globalSearchAliasesCopy.settings.terminalLineHeight),
    settingEntry("terminal-scrollback", copy.settings.terminalScrollback, copy.settings.workspaceTerminal, "settings-terminal-scrollback", globalSearchAliasesCopy.settings.terminalScrollback),
    settingEntry("terminal-cursor", copy.settings.terminalCursor, copy.settings.workspaceTerminal, "settings-terminal-cursor", globalSearchAliasesCopy.settings.terminalCursor),
    settingEntry("terminal-screen-reader", copy.settings.terminalScreenReader, copy.settings.workspaceTerminal, "settings-terminal-screen-reader", globalSearchAliasesCopy.settings.terminalScreenReader),
    settingEntry("terminal-paste", copy.settings.terminalConfirmLargePaste, copy.settings.workspaceTerminal, "settings-terminal-paste", globalSearchAliasesCopy.settings.terminalPaste),
    settingEntry("ssh", copy.settings.localSsh, copy.settings.localSsh, "settings-ssh", globalSearchAliasesCopy.settings.ssh, 30),
    settingEntry("public-key", copy.settings.publicKey, copy.settings.localSsh, "settings-ssh", globalSearchAliasesCopy.settings.publicKey),
    settingEntry("updates", copy.settings.appUpdates, copy.settings.appUpdates, "settings-updates", globalSearchAliasesCopy.settings.updates, 30),
    settingEntry("close-behavior", copy.settings.closeButtonBehavior, copy.settings.closeButton, "settings-close-behavior", globalSearchAliasesCopy.settings.closeBehavior),
    settingEntry("proxy", copy.settings.networkProxy, copy.settings.closeButton, "settings-proxy", globalSearchAliasesCopy.settings.proxy),
    settingEntry("launch-at-login", copy.settings.launchAtLogin, copy.settings.closeButton, "settings-launch-at-login", globalSearchAliasesCopy.settings.launchAtLogin)
  ];
}
