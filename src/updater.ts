import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

/** Whether the self-updater UI is compiled in. False for store builds (Mac App
 *  Store / Play), where self-updating binaries are disallowed — set via
 *  BALAUDECK_STORE_BUILD at bundle time (see vite.config.ts). */
export const updaterEnabled: boolean = __UPDATER_ENABLED__;

/** Desktop OS values reported by the `current_platform` command. */
export const DESKTOP_PLATFORMS = ["macos", "windows", "linux"];

export { check, relaunch };
export type { Update };
