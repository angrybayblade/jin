"use client";
import { useEffect, useRef, useState } from "react";

/** Inline rename (window.prompt does not work in the desktop shell): Enter saves, Escape or blur without changes cancels. */
export function RenameInput({ value, onSave, onCancel, label }: { value: string; onSave: (v: string) => void; onCancel: () => void; label: string }) {
  const [text, setText] = useState(value);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const commit = () => {
    const v = text.trim();
    if (v && v !== value) onSave(v);
    else onCancel();
  };
  return (
    <input
      ref={ref}
      className="rename-input"
      value={text}
      aria-label={label}
      onChange={(e) => setText(e.target.value)}
      // Inside a link (a sidebar row): clicking into the field must not follow it.
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        }
      }}
      onBlur={commit}
    />
  );
}
