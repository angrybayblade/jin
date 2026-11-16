"use client";
import { Streamdown, type Components } from "streamdown";

// Zero's markdown setup: jin's typography and named scroll regions instead of utility styles.
const components: Components = {
  a: ({ children, href }) => (
    <a className="link-chip" href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  ),
  pre: ({ children }) => (
    <pre data-scroll="both" tabIndex={0} aria-label="Code block">
      {children}
    </pre>
  ),
  table: ({ children }) => (
    <div className="markdown-table" data-scroll="both" tabIndex={0} role="region" aria-label="Table">
      <table>{children}</table>
    </div>
  ),
};

export function Markdown({ content, streaming = false }: { content: string; streaming?: boolean }) {
  return (
    <Streamdown className="message-markdown" components={components} mode={streaming ? "streaming" : "static"} isAnimating={streaming} controls={false} skipHtml>
      {content}
    </Streamdown>
  );
}
