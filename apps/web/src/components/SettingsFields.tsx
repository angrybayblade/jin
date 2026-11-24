"use client";
import { Eye, EyeOff, Plus, X } from "lucide-react";
import { useState } from "react";

/**
 * The fields the agents' settings editors are built from (Claude Code's, Codex's, pi's and
 * opencode's): a headed section, true / false / not set, a list of strings, environment
 * variables, a number and a choice. "Not set" leaves the key out, so the agent's own default
 * applies.
 */

export type Obj = Record<string, unknown>;
export const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** `settings` with `path` set to `value`; an empty value removes the key, and an object it empties. */
export function setIn(settings: Obj, path: string[], value: unknown): Obj {
  const [k, ...rest] = path;
  const next = { ...settings };
  if (rest.length) {
    const inner = setIn(isObj(next[k!]) ? (next[k!] as Obj) : {}, rest, value);
    if (Object.keys(inner).length) next[k!] = inner;
    else delete next[k!];
  } else if (value === undefined || value === "" || (Array.isArray(value) && value.length === 0) || (isObj(value) && Object.keys(value).length === 0)) delete next[k!];
  else next[k!] = value;
  return next;
}
export const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

export function Card({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="md-card">
      <div className="md-card-head is-static">
        <h3>{title}</h3>
        {hint && <span className="meta">{hint}</span>}
      </div>
      <div className="md-card-body">{children}</div>
    </section>
  );
}

/** true / false / not set: absent is not the same as false (Claude Code's own default applies). */
export function Tri({ label, value, onChange, hint }: { label: string; value: unknown; onChange: (v: boolean | undefined) => void; hint?: string }) {
  return (
    <label className="field">
      <span>{label}</span>
      <select value={value === true ? "on" : value === false ? "off" : ""} onChange={(e) => onChange(e.target.value === "on" ? true : e.target.value === "off" ? false : undefined)}>
        <option value="">Not set{hint ? ` (${hint})` : ""}</option>
        <option value="on">On</option>
        <option value="off">Off</option>
      </select>
    </label>
  );
}

/** A list of strings: edit in place, remove, add with Enter. */
export function List({ label, items, onChange, placeholder, mono = true }: { label: string; items: string[]; onChange: (v: string[]) => void; placeholder: string; mono?: boolean }) {
  const [add, setAdd] = useState("");
  const commit = () => {
    const v = add.trim();
    if (v && !items.includes(v)) onChange([...items, v]);
    setAdd("");
  };
  return (
    <div className="field cs-list">
      <span>
        {label} <span className="cs-count">{items.length || ""}</span>
      </span>
      {items.map((it, i) => (
        <div className="cs-row" key={`${i}:${it}`}>
          <input className={mono ? "mono" : undefined} defaultValue={it} spellCheck={false} onBlur={(e) => e.target.value.trim() !== it && onChange(items.map((x, j) => (j === i ? e.target.value.trim() : x)).filter(Boolean))} />
          <button type="button" className="button quiet icon-only small" aria-label={`Remove ${it}`} onClick={() => onChange(items.filter((_, j) => j !== i))}>
            <X size={13} />
          </button>
        </div>
      ))}
      <div className="cs-row">
        <input
          className={mono ? "mono" : undefined}
          value={add}
          spellCheck={false}
          placeholder={placeholder}
          onChange={(e) => setAdd(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            }
          }}
          onBlur={commit}
        />
        <button type="button" className="button quiet icon-only small" aria-label="Add" disabled={!add.trim()} onClick={commit}>
          <Plus size={13} />
        </button>
      </div>
    </div>
  );
}

/** Environment variables: values hidden until you ask (they are often tokens). */
export function Env({ env, onChange }: { env: Obj; onChange: (v: Obj) => void }) {
  const [shown, setShown] = useState<string[]>([]);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const entries = Object.entries(env).map(([k, v]) => [k, typeof v === "string" ? v : String(v)] as const);
  const add = () => {
    const k = name.trim();
    if (!k) return;
    onChange({ ...env, [k]: value });
    setName("");
    setValue("");
  };
  return (
    <div className="field cs-list">
      {entries.map(([k, v]) => (
        <div className="cs-row is-env" key={k}>
          <input className="mono" value={k} readOnly aria-label="Name" />
          <input className="mono" type={shown.includes(k) ? "text" : "password"} defaultValue={v} spellCheck={false} autoComplete="off" aria-label={`Value of ${k}`} onBlur={(e) => e.target.value !== v && onChange({ ...env, [k]: e.target.value })} />
          <button type="button" className="button quiet icon-only small" aria-label={shown.includes(k) ? "Hide" : "Show"} onClick={() => setShown((s) => (s.includes(k) ? s.filter((x) => x !== k) : [...s, k]))}>
            {shown.includes(k) ? <EyeOff size={13} /> : <Eye size={13} />}
          </button>
          <button
            type="button"
            className="button quiet icon-only small"
            aria-label={`Remove ${k}`}
            onClick={() => {
              const { [k]: _, ...rest } = env;
              onChange(rest);
            }}
          >
            <X size={13} />
          </button>
        </div>
      ))}
      <div className="cs-row is-env">
        <input className="mono" value={name} placeholder="NAME" spellCheck={false} onChange={(e) => setName(e.target.value.replace(/\s/g, ""))} aria-label="New name" />
        <input className="mono" type="password" value={value} placeholder="value" autoComplete="off" onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), add())} aria-label="New value" />
        <button type="button" className="button quiet icon-only small" aria-label="Add" disabled={!name.trim()} onClick={add}>
          <Plus size={13} />
        </button>
        <span />
      </div>
    </div>
  );
}


/** A whole number, or not set. */
export function Num({ label, value, onChange, placeholder, min = 0 }: { label: string; value: unknown; onChange: (v: number | undefined) => void; placeholder?: string; min?: number }) {
  return (
    <label className="field">
      <span>{label}</span>
      <input type="number" min={min} value={typeof value === "number" ? value : ""} placeholder={placeholder} onChange={(e) => onChange(e.target.value === "" ? undefined : Math.max(min, Math.floor(Number(e.target.value))))} />
    </label>
  );
}

/** One of a few values, or not set (`hint` says what not set means). A value the list does not know is kept and shown. */
export function Choice({ label, value, options, onChange, hint }: { label: string; value: unknown; options: readonly (string | { id: string; label: string })[]; onChange: (v: string | undefined) => void; hint?: string }) {
  const opts = options.map((o) => (typeof o === "string" ? { id: o, label: o } : o));
  const v = typeof value === "string" ? value : "";
  return (
    <label className="field">
      <span>{label}</span>
      <select value={v} onChange={(e) => onChange(e.target.value || undefined)}>
        <option value="">Not set{hint ? ` (${hint})` : ""}</option>
        {opts.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
        {v && !opts.some((o) => o.id === v) && <option value={v}>{v}</option>}
      </select>
    </label>
  );
}

/** A line of text, or not set. */
export function Text({ label, value, onChange, placeholder, mono = false, suggestions }: { label: string; value: unknown; onChange: (v: string | undefined) => void; placeholder?: string; mono?: boolean; suggestions?: readonly string[] }) {
  const id = suggestions ? `sf-${label.replace(/\W+/g, "-").toLowerCase()}` : undefined;
  return (
    <label className="field">
      <span>{label}</span>
      <input className={mono ? "mono" : undefined} list={id} value={typeof value === "string" ? value : ""} placeholder={placeholder} spellCheck={false} onChange={(e) => onChange(e.target.value.trim() || undefined)} />
      {suggestions && (
        <datalist id={id}>
          {suggestions.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      )}
    </label>
  );
}
