"use client";
// Zero's animated favicon (ComposioHQ/zero src/components/AnimatedFavicon.tsx): a tiny
// version of the thermal shader drawn into the tab icon; app/icon.svg is the fallback.
import { useEffect } from "react";
import { createRenderer } from "./ThermalMark";

export function AnimatedFavicon() {
  useEffect(() => {
    const canvas = document.createElement("canvas");
    const renderer = createRenderer(canvas, "blob");
    if (!renderer) return;
    const icon = document.createElement("link");
    icon.rel = "icon";
    icon.type = "image/png";
    icon.sizes = "32x32";
    document.head.appendChild(icon);
    const reduced = matchMedia("(prefers-reduced-motion: reduce)");
    let timer: ReturnType<typeof setInterval> | undefined;
    let phase = 2.7;
    const draw = () => {
      renderer.draw(phase, 0);
      icon.href = canvas.toDataURL("image/png");
    };
    const resume = () => {
      clearInterval(timer);
      if (document.hidden) return;
      draw();
      if (!reduced.matches)
        timer = setInterval(() => {
          phase += 0.625;
          draw();
        }, 500);
    };
    resume();
    reduced.addEventListener("change", resume);
    document.addEventListener("visibilitychange", resume);
    return () => {
      clearInterval(timer);
      reduced.removeEventListener("change", resume);
      document.removeEventListener("visibilitychange", resume);
      renderer.dispose();
      icon.remove();
    };
  }, []);
  return null;
}
