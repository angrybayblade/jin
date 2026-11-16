import type { BeforeMount } from "@monaco-editor/react";

const LANG: Record<string, string> = {
  ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  json: "json", md: "markdown", go: "go", py: "python", yaml: "yaml", yml: "yaml", sh: "shell", css: "css",
  html: "html", sql: "sql", prisma: "graphql", graphql: "graphql", toml: "ini", rs: "rust", dockerfile: "dockerfile",
};
export const language = (path: string) => LANG[(path.split(".").pop() ?? "").toLowerCase()] ?? (path.endsWith("Dockerfile") ? "dockerfile" : "plaintext");
export const base = (path: string) => path.slice(path.lastIndexOf("/") + 1);

// The coding tokens (tokens.css) as Monaco themes, light and dark.
export const defineTheme: BeforeMount = (monaco) => {
  monaco.editor.defineTheme("jin-light", {
    base: "vs",
    inherit: true,
    rules: [
      { token: "comment", foreground: "8b8a94" },
      { token: "keyword", foreground: "a13e28" },
      { token: "string", foreground: "455569" },
      { token: "number", foreground: "8a5a12" },
      { token: "type", foreground: "9d5034" },
    ],
    colors: {
      "editor.background": "#ffffff",
      "editor.foreground": "#29272b",
      "editorLineNumber.foreground": "#b8b7bb",
      "editorLineNumber.activeForeground": "#50515a",
      "editor.selectionBackground": "#f1d3ae",
      "editor.lineHighlightBackground": "#f7f7f7",
      "editorCursor.foreground": "#9d5034",
    },
  });
  monaco.editor.defineTheme("jin-dark", {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "comment", foreground: "7d7b87" },
      { token: "keyword", foreground: "e7952f" },
      { token: "string", foreground: "b9c2d6" },
      { token: "number", foreground: "f0c36d" },
      { token: "type", foreground: "e4b07a" },
    ],
    colors: {
      "editor.background": "#1b1a1e",
      "editor.foreground": "#e6e4ea",
      "editorLineNumber.foreground": "#4a4952",
      "editorLineNumber.activeForeground": "#b9b8c1",
      "editor.selectionBackground": "#3a2a1a",
      "editor.lineHighlightBackground": "#222126",
      "editorCursor.foreground": "#e7a35a",
    },
  });
};

