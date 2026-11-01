export const MAC_PERMISSION_SETTINGS_URLS = {
  "screen-recording":
    "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
  accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
  "full-disk-access":
    "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_AllFiles",
  "files-and-folders":
    "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_FilesAndFolders",
};

export type MacPermission = keyof typeof MAC_PERMISSION_SETTINGS_URLS;

/** Panes with an API to prompt for and read; macOS gives the others no API, so they only open. */
export type PromptableMacPermission = "accessibility" | "screen-recording";

export const isPromptableMacPermission = (
  permission: MacPermission,
): permission is PromptableMacPermission =>
  permission === "accessibility" || permission === "screen-recording";

export const MAC_PERMISSION_TITLES: Record<MacPermission, string> = {
  "screen-recording": "Screen Recording",
  accessibility: "Accessibility",
  "full-disk-access": "Full Disk Access",
  "files-and-folders": "Files & Folders",
};
