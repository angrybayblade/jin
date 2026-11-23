#!/usr/bin/env bun
// jin's own tools for one Codex run, as a stdio MCP server Codex starts (`mcp_servers.jin`).
// JIN_AGENT_TOOLS names the run's tools in the daemon (see agent-tools.ts); each list and call
// goes to the daemon, which runs the tool. Codex asks jin before each call (an MCP approval),
// so this server does no checking of its own.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const token = process.env.JIN_AGENT_TOOLS ?? "";
const home = process.env.JIN_HOME ?? join(homedir(), ".jin");
const daemon = JSON.parse(readFileSync(join(home, "daemon.json"), "utf8")) as { host: string; port: number; token: string };
const base = `http://${daemon.host}:${daemon.port}/api/agent-tools/${encodeURIComponent(token)}`;
const headers = { authorization: `Bearer ${daemon.token}`, "content-type": "application/json" };

const send = (msg: unknown) => process.stdout.write(`${JSON.stringify(msg)}\n`);

async function answer(m: { id?: number | string; method?: string; params?: any }) {
  if (m.id === undefined) return; // a notification
  if (m.method === "initialize") return send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "jin", version: "1" } } });
  if (m.method === "ping") return send({ jsonrpc: "2.0", id: m.id, result: {} });
  if (m.method === "tools/list") {
    try {
      const res = await fetch(base, { headers });
      const tools = res.ok ? await res.json() : [];
      return send({ jsonrpc: "2.0", id: m.id, result: { tools } });
    } catch (e) {
      return send({ jsonrpc: "2.0", id: m.id, error: { code: -32000, message: `could not reach jin: ${(e as Error).message}` } });
    }
  }
  if (m.method === "tools/call") {
    let out: { text?: string; error?: string };
    try {
      const res = await fetch(`${base}/${encodeURIComponent(String(m.params?.name ?? ""))}`, { method: "POST", headers, body: JSON.stringify({ args: m.params?.arguments ?? {} }) });
      out = (await res.json().catch(() => ({ error: `jin answered ${res.status}` }))) as { text?: string; error?: string };
      if (!res.ok && !out.error) out = { error: `jin answered ${res.status}` };
    } catch (e) {
      out = { error: `could not reach jin: ${(e as Error).message}` };
    }
    return send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: out.error ?? out.text ?? "" }], ...(out.error ? { isError: true } : {}) } });
  }
  send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `method not found: ${m.method}` } });
}

let buf = "";
for await (const chunk of Bun.stdin.stream()) {
  buf += new TextDecoder().decode(chunk);
  for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    try {
      void answer(JSON.parse(line));
    } catch {
      // not JSON: ignore
    }
  }
}
