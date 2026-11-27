/**
 * The system clipboard. In jin's desktop app it goes through the app: its webview refuses a
 * write that does not come straight from a click or key press, and a copy a terminal program
 * asks for (OSC 52, as Claude Code's text selection does) arrives a round trip later.
 */
export async function writeClipboard(text: string): Promise<void> {
  const host = typeof window === "undefined" ? undefined : (window as { __electrobunSendToHost?: (m: unknown) => void }).__electrobunSendToHost;
  if (host) return host({ type: "jin:clipboard-write", text });
  await navigator.clipboard.writeText(text);
}
