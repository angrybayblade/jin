"use client";
/** The Claude Code tab on screen, so jin does not notify about the session you are watching. */
let terminal: string | null = null;
export const setActiveTerminal = (id: string | null) => {
  terminal = id;
  window.dispatchEvent(new Event("jin:presence"));
};
export const activeTerminal = () => terminal;
