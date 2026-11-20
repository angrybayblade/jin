"use client";
import { Bell, BellOff, BellRing, Send, SlidersHorizontal } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { reportPresence, setNotifications, testNotification } from "@/lib/actions";
import type { NotificationSettings } from "@/lib/daemon";
import { activeTerminal } from "@/lib/presence";
import { contextMenu } from "./ContextMenu";

/**
 * Tells the daemon what is on screen (page, chat, Claude Code tab, whether the window is
 * focused) so it skips notifying about what you are already watching.
 */
export function PresenceReporter() {
  const path = usePathname();
  const params = useSearchParams();
  const chat = params.get("chat");
  useEffect(() => {
    let last = "";
    const report = (force = false) => {
      const now = { path, chat: chat && chat !== "new" ? chat : null, terminal: activeTerminal(), focused: document.hasFocus() && document.visibilityState === "visible" };
      const key = JSON.stringify(now);
      if (!force && key === last) return;
      last = key;
      void reportPresence(now).catch(() => {});
    };
    const onChange = () => report();
    report(true);
    const beat = setInterval(() => document.hasFocus() && report(true), 10_000);
    window.addEventListener("focus", onChange);
    window.addEventListener("blur", onChange);
    window.addEventListener("jin:presence", onChange);
    document.addEventListener("visibilitychange", onChange);
    return () => {
      clearInterval(beat);
      window.removeEventListener("focus", onChange);
      window.removeEventListener("blur", onChange);
      window.removeEventListener("jin:presence", onChange);
      document.removeEventListener("visibilitychange", onChange);
    };
  }, [path, chat]);
  return null;
}

type Mode = "sound" | "silent" | "off";
const modeOf = (s: NotificationSettings): Mode => (!s.enabled ? "off" : s.sound ? "sound" : "silent");
const NEXT: Record<Mode, Mode> = { sound: "silent", silent: "off", off: "sound" };
const LABEL: Record<Mode, string> = { sound: "Notifications with sound", silent: "Notifications without sound", off: "Notifications off" };
const settingsOf = (m: Mode): Pick<NotificationSettings, "enabled" | "sound"> => ({ enabled: m !== "off", sound: m === "sound" });

/** Sidebar bell: click cycles sound → silent → off; right-click to choose or send a test. */
export function NotificationToggle({ initial }: { initial: NotificationSettings }) {
  const [mode, setMode] = useState<Mode>(modeOf(initial));
  const router = useRouter();
  const choose = (m: Mode) => {
    setMode(m);
    void setNotifications(settingsOf(m)).catch(() => setMode(mode));
  };
  const Icon = mode === "sound" ? BellRing : mode === "silent" ? Bell : BellOff;
  return (
    <button
      type="button"
      className="button quiet icon-only"
      onClick={() => choose(NEXT[mode])}
      title={`${LABEL[mode]} (click for ${LABEL[NEXT[mode]].toLowerCase()}; right-click for more)`}
      aria-label={LABEL[mode]}
      {...contextMenu(() => [
        { header: "Notifications" },
        { label: "With sound", icon: BellRing, hint: mode === "sound" ? "on" : undefined, run: () => choose("sound") },
        { label: "Without sound", icon: Bell, hint: mode === "silent" ? "on" : undefined, run: () => choose("silent") },
        { label: "Off", icon: BellOff, hint: mode === "off" ? "on" : undefined, run: () => choose("off") },
        { divider: true },
        { label: "Choose what notifies…", icon: SlidersHorizontal, run: () => router.push("/notifications") },
        { label: "Send a test notification", icon: Send, run: () => void testNotification() },
      ])}
    >
      <Icon size={14} />
    </button>
  );
}
