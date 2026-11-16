import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";

const home = (yaml: string) => {
  const dir = mkdtempSync(join(tmpdir(), "jin-config-"));
  writeFileSync(join(dir, "config.yaml"), yaml);
  return dir;
};

test("one web origin, as 127.0.0.1 and as localhost", () => {
  const c = loadConfig(home("webOrigin: http://127.0.0.1:3917\n"));
  expect(c.webOrigin).toBe("http://127.0.0.1:3917");
  expect(c.webOrigins).toEqual(["http://127.0.0.1:3917", "http://localhost:3917"]);
});

test("a machine used by more than one jin lists each one's origin", () => {
  const c = loadConfig(home("webOrigins: [http://127.0.0.1:3917, http://127.0.0.1:3937]\n"));
  expect(c.webOrigin).toBe("http://127.0.0.1:3917");
  expect(c.webOrigins).toEqual(["http://127.0.0.1:3917", "http://localhost:3917", "http://127.0.0.1:3937", "http://localhost:3937"]);
});
