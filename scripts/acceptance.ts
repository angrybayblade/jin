// The v0 metric: how many of the 19 acceptance checks (A01..A19) pass.
// Each check is one test named "Annn ..."; a check that is missing counts as failing.
// Results come from bun's JUnit report: outside a terminal, bun test prints no line per passing test.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "jin-acceptance-"));
const report = join(dir, "junit.xml");
const proc = Bun.spawnSync(
  ["bun", "test", "tests/acceptance", "--timeout", "300000", "--reporter=junit", `--reporter-outfile=${report}`],
  { cwd: new URL("..", import.meta.url).pathname, stdout: "pipe", stderr: "pipe", env: process.env },
);
if (process.argv.includes("--verbose")) process.stdout.write(proc.stdout.toString() + proc.stderr.toString());

let xml = "";
try {
  xml = readFileSync(report, "utf8");
} catch {
  // no report: every check counts as failing
}
rmSync(dir, { recursive: true, force: true });

const passed = new Set<string>();
const failed = new Set<string>();
// <testcase name="A01 ..." ...> either self-closes (pass) or contains <failure>/<error>/<skipped>.
for (const m of xml.matchAll(/<testcase\b[^>]*\bname="(A\d{2})[^"]*"[^>]*?(\/>|>([\s\S]*?)<\/testcase>)/g)) {
  const [, id, , inner] = m;
  if (!id) continue;
  if (inner && /<(failure|error|skipped)\b/.test(inner)) failed.add(id);
  else passed.add(id);
}
for (const id of failed) passed.delete(id);
const all = Array.from({ length: 19 }, (_, i) => `A${String(i + 1).padStart(2, "0")}`);
for (const id of all) if (!passed.has(id)) failed.add(id);
console.log(`failing: ${[...failed].sort().join(" ") || "none"}`);
console.log(`ACCEPTANCE ${passed.size}/${all.length}`);
process.exit(passed.size === all.length ? 0 : 1);
