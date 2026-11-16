/** Fuzzy score for palette items (higher is better), or null when the letters are not in order. */
export function fuzzy(query: string, text: string): number | null {
  const q = query.toLowerCase().replace(/\s+/g, "");
  if (!q) return 0;
  const t = text.toLowerCase();
  let best: number | null = null;
  for (let start = t.indexOf(q[0]!), tries = 0; start >= 0 && tries < 20; start = t.indexOf(q[0]!, start + 1), tries++) {
    let score = 0;
    let pos = start;
    let run = 0;
    let ok = true;
    for (const ch of q) {
      const at = t.indexOf(ch, pos);
      if (at < 0) {
        ok = false;
        break;
      }
      const prev = text[at - 1];
      const boundary = at === 0 || prev === " " || prev === "/" || prev === "-" || prev === "·";
      run = at === pos && at > start ? run + 1 : 0;
      score += 1 + (boundary ? 5 : 0) + run * 3;
      pos = at + 1;
    }
    if (ok && (best === null || score > best)) best = score - text.length * 0.01;
  }
  return best;
}
