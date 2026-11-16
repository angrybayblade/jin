"use client";
import { Monitor, Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";
import { appThemeChoice, setAppTheme, type ThemeChoice } from "@/lib/theme";

const NEXT: Record<ThemeChoice, ThemeChoice> = { system: "light", light: "dark", dark: "system" };
const ICON = { system: Monitor, light: Sun, dark: Moon };

/**
 * Cycles System → Light → Dark. Without `onChange` it sets the app-wide theme; with it, a
 * pane's own override ("system" there means: follow the app).
 */
export function ThemeToggle({ value, onChange, label = "Theme" }: { value?: ThemeChoice; onChange?: (c: ThemeChoice) => void; label?: string }) {
  const [app, setApp] = useState<ThemeChoice>("system");
  useEffect(() => setApp(appThemeChoice()), []);
  const current = value ?? app;
  const Icon = ICON[current];
  const words = onChange ? { system: "follows the app", light: "light", dark: "dark" } : { system: "follows your system", light: "light", dark: "dark" };
  return (
    <button
      type="button"
      className="button quiet icon-only"
      title={`${label}: ${words[current]} (click to change)`}
      aria-label={`${label}: ${words[current]}`}
      onClick={() => {
        const next = NEXT[current];
        if (onChange) onChange(next);
        else {
          setAppTheme(next);
          setApp(next);
        }
      }}
    >
      <Icon size={14} />
    </button>
  );
}
