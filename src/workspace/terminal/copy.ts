import type { WorkspaceLocale, WorkspaceTerminalSession } from "../types";

export type TerminalUiCopy = {
  toolbar: string;
  newTerminal: string;
  split: string;
  exitSplit: string;
  fullscreen: string;
  exitFullscreen: string;
  reconnect: string;
  theme: string;
  themePreference: string;
  close: string;
  themeDark: string;
  themeLight: string;
  themeContrast: string;
  hostPickerTitle: string;
  hostPickerDescription: string;
  closeHostPicker: string;
  sessionDuration: string;
  renderer: string;
  protocol: string;
  terminalPane: string;
  states: Record<WorkspaceTerminalSession["state"], string>;
};

const en: TerminalUiCopy = {
  toolbar: "Terminal actions",
  newTerminal: "New terminal",
  split: "Split with files",
  exitSplit: "Close split",
  fullscreen: "Full screen",
  exitFullscreen: "Exit full screen",
  reconnect: "Reconnect",
  theme: "Theme",
  themePreference: "Use terminal setting",
  close: "Close terminal",
  themeDark: "Dark",
  themeLight: "Light",
  themeContrast: "High contrast",
  hostPickerTitle: "Choose a host",
  hostPickerDescription: "Open a new SSH terminal on the selected host.",
  closeHostPicker: "Close host selection",
  sessionDuration: "Session",
  renderer: "UTF-8 renderer",
  protocol: "SSH",
  terminalPane: "Terminal pane",
  states: {
    creating: "Creating",
    connecting: "Connecting",
    connected: "Connected",
    reconnecting: "Reconnecting",
    disconnected: "Disconnected",
    closing: "Closing",
    closed: "Closed",
    failed: "Failed"
  }
};

const zh: TerminalUiCopy = {
  toolbar: "终端操作",
  newTerminal: "新建终端",
  split: "分屏",
  exitSplit: "关闭分屏",
  fullscreen: "全屏",
  exitFullscreen: "退出全屏",
  reconnect: "重连",
  theme: "主题",
  themePreference: "使用终端设置",
  close: "关闭终端",
  themeDark: "深色",
  themeLight: "浅色",
  themeContrast: "高对比度",
  hostPickerTitle: "选择主机",
  hostPickerDescription: "将在所选主机上新建 SSH 终端。",
  closeHostPicker: "关闭主机选择",
  sessionDuration: "会话时长",
  renderer: "UTF-8 渲染",
  protocol: "SSH",
  terminalPane: "终端窗格",
  states: {
    creating: "创建中",
    connecting: "连接中",
    connected: "已连接",
    reconnecting: "重连中",
    disconnected: "已断开",
    closing: "关闭中",
    closed: "已关闭",
    failed: "失败"
  }
};

export const terminalUiCopy: Record<WorkspaceLocale, TerminalUiCopy> = { en, zh };
