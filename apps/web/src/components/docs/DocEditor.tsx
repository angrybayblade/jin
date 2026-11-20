"use client";
import { Extension, EditorContent, useEditor, type Editor } from "@tiptap/react";
import { StarterKit } from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import { Placeholder } from "@tiptap/extensions";
import { TableKit } from "@tiptap/extension-table";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Bold, Code, Heading1, Heading2, Heading3, Italic, Link2, List, ListChecks, ListOrdered, Minus, MessageSquarePlus, Pilcrow, Quote, SquareCode, Strikethrough, Table } from "lucide-react";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { DocAnchor } from "@/lib/daemon";

/**
 * The doc editor: blocks (headings, lists, to-dos, quotes, code, tables) edited as in Notion and
 * saved as markdown. `/` at the start of a line opens the block menu; a selection shows a small
 * toolbar with Comment. Comment threads and jin's suggestions are marked in the text (found by
 * their quote, as the daemon finds them), and a click on one opens it beside the doc.
 */

export interface Annotation {
  id: string;
  kind: "thread" | "suggestion";
  anchor: DocAnchor;
  /** A suggestion's new text (markdown). */
  replacement?: string;
}

export interface DocEditorHandle {
  /** Replace the text (a version from elsewhere, an accepted suggestion); does not count as an edit. Returns it as the editor writes it. */
  setBody(markdown: string): string;
  getMarkdown(): string;
  focus(): void;
}

// ---------------------------------------------------------------- finding quotes in the editor

/** What markdown reads as on the page: no block markers, link targets or inline marks; spaces collapsed. */
export function displayText(md: string): string {
  return md
    .replace(/^\s*(#{1,6}\s+|[-*+]\s+(\[[ xX]\]\s+)?|\d+[.)]\s+|>\s?)/gm, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** The doc's text with block breaks as spaces, and the document position of every character. */
function textIndex(doc: PMNode): { text: string; pos: number[] } {
  let text = "";
  const pos: number[] = [];
  doc.descendants((node, p) => {
    if (node.isTextblock && text.length && text[text.length - 1] !== " ") {
      text += " ";
      pos.push(p);
    }
    if (node.isText && node.text) {
      for (let i = 0; i < node.text.length; i++) {
        const ch = node.text[i]!;
        text += /\s/.test(ch) ? " " : ch;
        pos.push(p + i);
      }
    }
  });
  return { text, pos };
}

const tail = (a: string, b: string) => {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
};

/** Where an anchor's quote is in the editor's text (character offsets), or null. */
function findQuote(idx: { text: string }, a: DocAnchor): { start: number; end: number } | null {
  const q = displayText(a.quote);
  if (!q) return null;
  const hits: number[] = [];
  for (let i = idx.text.indexOf(q); i >= 0; i = idx.text.indexOf(q, i + 1)) hits.push(i);
  if (!hits.length) return null;
  const before = displayText(a.prefix ?? "");
  const best = hits.length === 1 ? hits[0]! : hits.reduce((b, h) => (tail(idx.text.slice(Math.max(0, h - 60), h).trimEnd(), before) > tail(idx.text.slice(Math.max(0, b - 60), b).trimEnd(), before) ? h : b));
  return { start: best, end: best + q.length };
}

type AnnoState = { annos: Annotation[]; active: string | null; set: DecorationSet };
const annoKey = new PluginKey<AnnoState>("docAnnotations");

function decorate(doc: PMNode, annos: Annotation[], active: string | null): DecorationSet {
  const idx = textIndex(doc);
  const out: Decoration[] = [];
  const at = (i: number) => idx.pos[Math.min(i, idx.pos.length - 1)]!;
  for (const a of annos) {
    const hit = findQuote(idx, a.anchor);
    if (!hit) continue;
    const cls = `doc-anno is-${a.kind}${a.id === active ? " is-active" : ""}`;
    if (a.kind === "thread") {
      out.push(Decoration.inline(at(hit.start), at(hit.end - 1) + 1, { class: cls, "data-anno": a.id }));
      continue;
    }
    // A suggestion: strike only what changes, and show what comes in its place.
    const from = displayText(a.anchor.quote);
    const to = displayText(a.replacement ?? "");
    let head = 0;
    while (head < from.length && head < to.length && from[head] === to[head]) head++;
    let back = 0;
    while (back < from.length - head && back < to.length - head && from[from.length - 1 - back] === to[to.length - 1 - back]) back++;
    const s = hit.start + head;
    const e = hit.end - back;
    if (e > s) out.push(Decoration.inline(at(s), at(e - 1) + 1, { class: `${cls} is-removed`, "data-anno": a.id }));
    const added = to.slice(head, to.length - back);
    if (added) {
      const where = e > s ? at(e - 1) + 1 : at(s);
      out.push(
        Decoration.widget(
          where,
          () => {
            const el = document.createElement("span");
            el.className = `${cls} is-added`;
            el.dataset.anno = a.id;
            el.textContent = added.length > 400 ? `${added.slice(0, 400)}…` : added;
            return el;
          },
          { side: 1, key: `${a.id}:${added.length}:${a.id === active}` },
        ),
      );
    }
  }
  return DecorationSet.create(doc, out);
}

function annotations(onClick: (id: string) => void) {
  return Extension.create({
    name: "docAnnotations",
    addProseMirrorPlugins() {
      return [
        new Plugin<AnnoState>({
          key: annoKey,
          state: {
            init: (_, state): AnnoState => ({ annos: [], active: null, set: DecorationSet.create(state.doc, []) }),
            apply(tr, value, _old, state) {
              const meta = tr.getMeta(annoKey) as { annos: Annotation[]; active: string | null } | undefined;
              if (meta) return { ...meta, set: decorate(state.doc, meta.annos, meta.active) };
              // Text changed: find the quotes again (an edit can bring one back or take it away).
              if (tr.docChanged) return { ...value, set: decorate(state.doc, value.annos, value.active) };
              return value;
            },
          },
          props: {
            decorations: (state) => annoKey.getState(state)?.set,
            handleClick: (_view, _pos, event) => {
              const el = (event.target as HTMLElement).closest<HTMLElement>("[data-anno]");
              if (!el?.dataset.anno) return false;
              onClick(el.dataset.anno);
              return false;
            },
          },
        }),
      ];
    },
  });
}

// ---------------------------------------------------------------- the block menu

interface Block {
  key: string;
  label: string;
  hint: string;
  icon: typeof Pilcrow;
  run: (e: Editor) => void;
}

const BLOCKS: Block[] = [
  { key: "text", label: "Text", hint: "plain paragraph", icon: Pilcrow, run: (e) => e.chain().focus().setParagraph().run() },
  { key: "h1", label: "Heading 1", hint: "#", icon: Heading1, run: (e) => e.chain().focus().setHeading({ level: 1 }).run() },
  { key: "h2", label: "Heading 2", hint: "##", icon: Heading2, run: (e) => e.chain().focus().setHeading({ level: 2 }).run() },
  { key: "h3", label: "Heading 3", hint: "###", icon: Heading3, run: (e) => e.chain().focus().setHeading({ level: 3 }).run() },
  { key: "bullet", label: "Bulleted list", hint: "-", icon: List, run: (e) => e.chain().focus().toggleBulletList().run() },
  { key: "numbered", label: "Numbered list", hint: "1.", icon: ListOrdered, run: (e) => e.chain().focus().toggleOrderedList().run() },
  { key: "todo", label: "To-do list", hint: "[ ]", icon: ListChecks, run: (e) => e.chain().focus().toggleTaskList().run() },
  { key: "quote", label: "Quote", hint: ">", icon: Quote, run: (e) => e.chain().focus().toggleBlockquote().run() },
  { key: "code", label: "Code block", hint: "```", icon: SquareCode, run: (e) => e.chain().focus().toggleCodeBlock().run() },
  { key: "table", label: "Table", hint: "3×3", icon: Table, run: (e) => e.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
  { key: "divider", label: "Divider", hint: "---", icon: Minus, run: (e) => e.chain().focus().setHorizontalRule().run() },
];

/** `/query` typed at the start of an empty line, before the caret. */
function slashQuery(e: Editor): { q: string; from: number } | null {
  const { $from, empty } = e.state.selection;
  if (!empty || !$from.parent.isTextblock || $from.parent.type.name === "codeBlock") return null;
  const before = $from.parent.textBetween(0, $from.parentOffset, undefined, "￼");
  const m = /^\/([\w ]{0,20})$/.exec(before);
  return m ? { q: m[1]!.toLowerCase(), from: $from.start() } : null;
}

// ---------------------------------------------------------------- the editor

export const DocEditor = forwardRef<
  DocEditorHandle,
  {
    initial: string;
    onChange: (markdown: string) => void;
    annotations: Annotation[];
    active: string | null;
    onAnnotation: (id: string) => void;
    onComment: (anchor: DocAnchor) => void;
    /** The text as the editor writes it, once loaded (its markdown can differ in spacing from what was stored). */
    onReady?: (markdown: string) => void;
    placeholder?: string;
  }
>(function DocEditor({ initial, onChange, annotations: annos, active, onAnnotation, onComment, onReady, placeholder }, ref) {
  const wrap = useRef<HTMLDivElement>(null);
  const quiet = useRef(false);
  const cb = useRef({ onChange, onAnnotation, onReady });
  cb.current = { onChange, onAnnotation, onReady };
  const [slash, setSlash] = useState<{ q: string; from: number; x: number; y: number; index: number } | null>(null);
  const slashRef = useRef(slash);
  slashRef.current = slash;
  const [bar, setBar] = useState<{ x: number; y: number } | null>(null);

  const blocksFor = (q: string) => BLOCKS.filter((b) => !q || b.label.toLowerCase().includes(q) || b.key.startsWith(q));

  const place = (e: Editor, pos: number) => {
    const box = wrap.current?.getBoundingClientRect();
    const c = e.view.coordsAtPos(pos);
    return { x: c.left - (box?.left ?? 0), y: c.bottom - (box?.top ?? 0) };
  };

  const refresh = (e: Editor) => {
    const s = slashQuery(e);
    if (s) {
      const p = place(e, e.state.selection.from);
      setSlash((old) => ({ ...s, ...p, index: old && old.q === s.q ? old.index : 0 }));
    } else setSlash(null);
    const sel = e.state.selection;
    if (!sel.empty && !e.isActive("codeBlock") && e.view.hasFocus()) {
      const box = wrap.current?.getBoundingClientRect();
      const a = e.view.coordsAtPos(sel.from);
      const b = e.view.coordsAtPos(sel.to);
      // Centred over the selection, kept inside the editor (the bar is about 280px wide).
      const mid = (Math.min(a.left, b.left) + Math.max(a.right, b.right)) / 2 - (box?.left ?? 0);
      setBar({ x: Math.max(140, Math.min(mid, (box?.width ?? 600) - 140)), y: Math.min(a.top, b.top) - (box?.top ?? 0) });
    } else setBar(null);
  };

  const choose = (e: Editor, b: Block) => {
    const s = slashQuery(e);
    if (s) e.chain().focus().deleteRange({ from: s.from, to: e.state.selection.from }).run();
    b.run(e);
    setSlash(null);
  };

  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({ link: { openOnClick: false, autolink: true } }),
      TaskList,
      TaskItem.configure({ nested: true }),
      TableKit.configure({ table: { resizable: false } }),
      Placeholder.configure({ placeholder: ({ node }) => (node.type.name === "heading" ? "Heading" : (placeholder ?? "Write, or press / for blocks…")) }),
      Markdown,
      annotations((id) => cb.current.onAnnotation(id)),
    ],
    content: initial,
    contentType: "markdown",
    editorProps: {
      attributes: { class: "doc-prose", spellcheck: "true" },
      handleKeyDown: (view, event) => {
        const s = slashRef.current;
        if (!s || !editor) return false;
        const list = blocksFor(s.q);
        if (event.key === "Escape") {
          setSlash(null);
          return true;
        }
        if (!list.length) return false;
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          setSlash({ ...s, index: (s.index + (event.key === "ArrowDown" ? 1 : list.length - 1)) % list.length });
          return true;
        }
        if (event.key === "Enter" || event.key === "Tab") {
          choose(editor, list[Math.min(s.index, list.length - 1)]!);
          return true;
        }
        void view;
        return false;
      },
    },
    onUpdate: ({ editor: e }) => {
      refresh(e);
      if (!quiet.current) cb.current.onChange(e.getMarkdown());
    },
    onCreate: ({ editor: e }) => cb.current.onReady?.(e.getMarkdown()),
    onSelectionUpdate: ({ editor: e }) => refresh(e),
    onBlur: () => setTimeout(() => setBar(null), 150),
  });

  useImperativeHandle(
    ref,
    () => ({
      setBody(markdown: string) {
        if (!editor) return markdown;
        quiet.current = true;
        try {
          editor.commands.setContent(markdown, { contentType: "markdown", emitUpdate: true });
        } finally {
          quiet.current = false;
        }
        return editor.getMarkdown();
      },
      getMarkdown: () => editor?.getMarkdown() ?? initial,
      // At once (not a frame later), so typing straight after Enter in the title lands in the doc.
      focus: () => {
        editor?.view.focus();
        editor?.commands.focus("start");
      },
    }),
    [editor, initial],
  );

  // The marks follow the threads and suggestions (and which one is open).
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    editor.view.dispatch(editor.state.tr.setMeta(annoKey, { annos, active }).setMeta("addToHistory", false));
  }, [editor, annos, active]);

  const comment = () => {
    if (!editor) return;
    const { from, to } = editor.state.selection;
    const doc = editor.state.doc;
    const quote = doc.textBetween(from, to, " ", " ").trim();
    if (!quote) return;
    onComment({ quote, prefix: doc.textBetween(Math.max(0, from - 40), from, " ", " "), suffix: doc.textBetween(to, Math.min(doc.content.size, to + 40), " ", " ") });
    setBar(null);
  };

  const link = () => {
    if (!editor) return;
    const was = editor.getAttributes("link").href as string | undefined;
    const href = window.prompt("Link to", was ?? "https://");
    if (href === null) return;
    if (!href.trim()) editor.chain().focus().unsetLink().run();
    else editor.chain().focus().extendMarkRange("link").setLink({ href: href.trim() }).run();
  };

  const list = slash ? blocksFor(slash.q) : [];
  return (
    <div ref={wrap} className="doc-editor">
      <EditorContent editor={editor} />
      {editor && bar && (
        <div className="doc-bar" style={{ left: bar.x, top: bar.y }} onMouseDown={(e) => e.preventDefault()}>
          <button type="button" className={editor.isActive("bold") ? "is-on" : ""} onClick={() => editor.chain().focus().toggleBold().run()} title="Bold (⌘B)" aria-label="Bold">
            <Bold size={14} />
          </button>
          <button type="button" className={editor.isActive("italic") ? "is-on" : ""} onClick={() => editor.chain().focus().toggleItalic().run()} title="Italic (⌘I)" aria-label="Italic">
            <Italic size={14} />
          </button>
          <button type="button" className={editor.isActive("strike") ? "is-on" : ""} onClick={() => editor.chain().focus().toggleStrike().run()} title="Strikethrough" aria-label="Strikethrough">
            <Strikethrough size={14} />
          </button>
          <button type="button" className={editor.isActive("code") ? "is-on" : ""} onClick={() => editor.chain().focus().toggleCode().run()} title="Code" aria-label="Code">
            <Code size={14} />
          </button>
          <button type="button" className={editor.isActive("link") ? "is-on" : ""} onClick={link} title="Link" aria-label="Link">
            <Link2 size={14} />
          </button>
          <span className="doc-bar-sep" />
          <button type="button" className="doc-bar-comment" onClick={comment} title="Comment on this">
            <MessageSquarePlus size={14} /> Comment
          </button>
        </div>
      )}
      {editor && slash && list.length > 0 && (
        <div className="doc-slash" role="listbox" aria-label="Blocks" style={{ left: slash.x, top: slash.y + 4 }} onMouseDown={(e) => e.preventDefault()}>
          {list.map((b, i) => (
            <button key={b.key} type="button" role="option" aria-selected={i === slash.index} className={i === slash.index ? "is-active" : ""} onMouseEnter={() => setSlash({ ...slash, index: i })} onClick={() => choose(editor, b)}>
              <b.icon size={15} />
              <span>{b.label}</span>
              <span className="meta mono">{b.hint}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
});
