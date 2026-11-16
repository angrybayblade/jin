"use client";
import { Streamdown, type Components } from "streamdown";
import { isPullRequest } from "@/lib/pr";
import { BobbyBadge } from "./BobbyBadge";

// Zero's markdown setup: jin's typography and named scroll regions instead of utility styles.
// Streamdown's defaults rely on Tailwind classes (bold is a font-semibold span), which jin
// does not load, so inline formatting maps back to plain elements styled in globals.css.
const components: Components = {
  strong: ({ children }) => <strong>{children}</strong>,
  em: ({ children }) => <em>{children}</em>,
  del: ({ children }) => <del>{children}</del>,
  code: ({ children, className }) => <code className={className}>{children}</code>,
  a: ({ children, href }) => (
    <>
      <a className="link-chip" href={href} target="_blank" rel="noreferrer">
        {children}
      </a>
      {isPullRequest(href) && <BobbyBadge pr={href} compact />}
    </>
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
