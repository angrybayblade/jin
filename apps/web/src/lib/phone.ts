/**
 * Phone layout: below the 760px breakpoint (the same one globals.css uses) the sidebar is a
 * drawer over the page and a page shows one pane at a time. The drawer's state lives on <html>
 * (data-drawer="open") so the CSS and every control read the same thing.
 */
import { useSyncExternalStore } from "react";
import { PHONE_QUERY } from "./layout";

export { PHONE_QUERY };

export const isPhone = () => typeof window !== "undefined" && window.matchMedia(PHONE_QUERY).matches;

const subscribePhone = (cb: () => void) => {
  const mq = window.matchMedia(PHONE_QUERY);
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
};

/** True on a phone-sized window (false on the server and the first paint). */
export function usePhone(): boolean {
  return useSyncExternalStore(subscribePhone, isPhone, () => false);
}

const DRAWER_EVENT = "jin-drawer";

export const drawerOpen = () => typeof document !== "undefined" && document.documentElement.dataset.drawer === "open";

export function setDrawer(open: boolean) {
  const r = document.documentElement;
  if (open === drawerOpen()) return;
  if (open) r.dataset.drawer = "open";
  else delete r.dataset.drawer;
  window.dispatchEvent(new Event(DRAWER_EVENT));
}

/** Whether the phone drawer is open. */
export function useDrawer(): boolean {
  return useSyncExternalStore(
    (cb) => {
      window.addEventListener(DRAWER_EVENT, cb);
      return () => window.removeEventListener(DRAWER_EVENT, cb);
    },
    drawerOpen,
    () => false,
  );
}
