"use client";
import { useEffect, useState, type RefObject } from "react";

export type ThemeChoice = "system" | "light" | "dark";
export type Theme = "light" | "dark";

export const THEME_COOKIE = "jin-theme";

/** Apply the app-wide theme: <html data-theme>, and a cookie so the server renders it on the next load. */
export function setAppTheme(choice: ThemeChoice) {
  const root = document.documentElement;
  if (choice === "system") delete root.dataset.theme;
  else root.dataset.theme = choice;
  document.cookie = `${THEME_COOKIE}=${choice}; path=/; max-age=31536000; samesite=lax`;
}

export function appThemeChoice(): ThemeChoice {
  const t = document.documentElement.dataset.theme;
  return t === "light" || t === "dark" ? t : "system";
}

/** The theme in effect at an element: the nearest data-theme above it, else the system preference. */
function resolve(el: Element | null): Theme {
  const owner = el?.closest("[data-theme]") ?? document.documentElement;
  const t = owner.getAttribute("data-theme");
  if (t === "light" || t === "dark") return t;
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** Follows the theme at `ref` as the app theme, a region's override or the system preference change. */
export function useResolvedTheme(ref: RefObject<Element | null>): Theme {
  const [theme, setTheme] = useState<Theme>("light");
  useEffect(() => {
    const update = () => setTheme(resolve(ref.current));
    update();
    const media = matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", update);
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"], subtree: true });
    return () => {
      media.removeEventListener("change", update);
      observer.disconnect();
    };
  }, [ref]);
  return theme;
}

/** A pane's own theme override, remembered per pane in this browser. */
export function usePaneTheme(key: string): [ThemeChoice, (c: ThemeChoice) => void] {
  const storageKey = `jin-pane-theme:${key}`;
  const [choice, setChoice] = useState<ThemeChoice>("system");
  useEffect(() => {
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved === "light" || saved === "dark" || saved === "system") setChoice(saved);
    } catch {}
  }, [storageKey]);
  const set = (c: ThemeChoice) => {
    setChoice(c);
    try {
      localStorage.setItem(storageKey, c);
    } catch {}
  };
  return [choice, set];
}
