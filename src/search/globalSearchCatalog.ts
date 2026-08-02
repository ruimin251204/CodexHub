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

export type GlobalSearchCatalogCopy = {
  navItems: readonly { id: SearchSectionId; label: string }[];
  sections: Record<SearchSectionId, { body: string; title: string }>;
  settings: Record<SettingsSearchCopyKey, string>;
};

export type CodexHubSearchEntry = GlobalSearchEntry & {
  section: SearchSectionId;
  hostAlias?: string;
};

const sectionSearchAliases: Record<SearchSectionId, string[]> = {
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
};

/** 构建稳定的双语页面与设置项目录；动态主机由 App 在运行时追加。 */
export function createGlobalSearchCatalog(copy: GlobalSearchCatalogCopy): CodexHubSearchEntry[] {
  const settingsPage = copy.navItems.find((item) => item.id === "settings")?.label ?? copy.sections.settings.title;
  const settingDetail = (group: string) => `${settingsPage} · ${group}`;
  const settingEntry = (
    id: string,
    label: string,
    group: string,
    targetId: string,
    keywords: string[],
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
    keywords: sectionSearchAliases[item.id],
    priority: 10
  }));

  return [...pages,
    settingEntry("appearance", copy.settings.appearance, copy.settings.appearance, "settings-appearance", ["appearance", "interface", "外观", "界面"], 30),
    settingEntry("theme", copy.settings.theme, copy.settings.appearance, "settings-theme", ["theme", "system theme", "dark", "light", "主题", "系统主题", "深色", "浅色"], 40),
    settingEntry("platform", copy.settings.platformAppearance, copy.settings.appearance, "settings-platform", ["platform", "windows", "macos", "mac", "平台", "系统风格", "外观平台"]),
    settingEntry("font", copy.settings.font, copy.settings.appearance, "settings-font", ["font", "typeface", "ui font", "字体", "界面字体"], 40),
    settingEntry("application-behavior", copy.settings.settingsBehavior, copy.settings.appearance, "settings-application-behavior", ["application behavior", "behavior", "应用行为", "行为"]),
    settingEntry("sidebar-indicators", copy.settings.sidebarCompletionIndicators, copy.settings.settingsBehavior, "settings-sidebar-indicators", ["sidebar indicator", "completion", "侧栏提示", "完成提示"]),
    settingEntry("log-popups", copy.settings.hostOperationLogPopups, copy.settings.settingsBehavior, "settings-log-popups", ["log popup", "host log", "日志弹窗", "主机日志"]),
    settingEntry("privacy", copy.settings.personalInfoMasking, copy.settings.settingsBehavior, "settings-privacy", ["privacy", "mask", "personal information", "隐私", "脱敏", "个人信息"]),
    settingEntry("terminal", copy.settings.workspaceTerminal, copy.settings.workspaceTerminal, "settings-terminal", ["terminal settings", "workspace terminal", "终端设置", "工作台终端"], 30),
    settingEntry("terminal-font", copy.settings.terminalFontFamily, copy.settings.workspaceTerminal, "settings-terminal-font", ["terminal font", "monospace", "终端字体", "等宽字体"]),
    settingEntry("terminal-colors", copy.settings.terminalColorScheme, copy.settings.workspaceTerminal, "settings-terminal-colors", ["terminal theme", "color scheme", "high contrast", "终端主题", "配色", "高对比度"]),
    settingEntry("terminal-font-size", copy.settings.terminalFontSize, copy.settings.workspaceTerminal, "settings-terminal-font-size", ["font size", "text size", "字号", "终端字号"]),
    settingEntry("terminal-line-height", copy.settings.terminalLineHeight, copy.settings.workspaceTerminal, "settings-terminal-line-height", ["line height", "spacing", "行高", "行距"]),
    settingEntry("terminal-scrollback", copy.settings.terminalScrollback, copy.settings.workspaceTerminal, "settings-terminal-scrollback", ["scrollback", "history lines", "回滚行数", "历史行数"]),
    settingEntry("terminal-cursor", copy.settings.terminalCursor, copy.settings.workspaceTerminal, "settings-terminal-cursor", ["cursor", "block", "underline", "光标", "方块", "下划线"]),
    settingEntry("terminal-screen-reader", copy.settings.terminalScreenReader, copy.settings.workspaceTerminal, "settings-terminal-screen-reader", ["screen reader", "accessibility", "读屏", "屏幕阅读", "无障碍"]),
    settingEntry("terminal-paste", copy.settings.terminalConfirmLargePaste, copy.settings.workspaceTerminal, "settings-terminal-paste", ["large paste", "paste confirmation", "大粘贴", "粘贴确认"]),
    settingEntry("ssh", copy.settings.localSsh, copy.settings.localSsh, "settings-ssh", ["ssh key", "ed25519", "local key", "ssh 密钥", "本地密钥", "私钥", "公钥"], 30),
    settingEntry("public-key", copy.settings.publicKey, copy.settings.localSsh, "settings-ssh", ["public key", "copy key", "公钥", "复制公钥"]),
    settingEntry("updates", copy.settings.appUpdates, copy.settings.appUpdates, "settings-updates", ["update", "updates", "version", "upgrade", "更新", "版本", "升级"], 30),
    settingEntry("close-behavior", copy.settings.closeButtonBehavior, copy.settings.closeButton, "settings-close-behavior", ["close button", "quit", "minimize to tray", "关闭按钮", "退出", "最小化到托盘"]),
    settingEntry("proxy", copy.settings.networkProxy, copy.settings.closeButton, "settings-proxy", ["proxy", "network", "http proxy", "代理", "网络代理", "网络"]),
    settingEntry("launch-at-login", copy.settings.launchAtLogin, copy.settings.closeButton, "settings-launch-at-login", ["launch at login", "startup", "autostart", "boot", "开机自启", "自动启动", "启动项"])
  ];
}
