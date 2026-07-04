import React, { useEffect, useMemo, useRef, useState } from "react";

void React;

export type QuickOpenEntryKind = "room" | "agent" | "message" | "command";

export type QuickOpenEntry = {
  id: string;
  kind: QuickOpenEntryKind;
  title: string;
  subtitle?: string;
  keywords?: string[];
  run: () => void | Promise<void>;
};

type Props = {
  open: boolean;
  entries: QuickOpenEntry[];
  onClose: () => void;
};

const kindLabels: Record<QuickOpenEntryKind, string> = {
  room: "Workspace",
  agent: "Agent",
  message: "Message",
  command: "Command",
};

const scoreEntry = (entry: QuickOpenEntry, query: string) => {
  if (!query) return 1;
  const title = entry.title.toLowerCase();
  const subtitle = entry.subtitle?.toLowerCase() ?? "";
  const keywords = entry.keywords?.join(" ").toLowerCase() ?? "";
  if (title === query) return 100;
  if (title.startsWith(query)) return 80;
  if (title.includes(query)) return 60;
  if (subtitle.includes(query)) return 35;
  if (keywords.includes(query)) return 25;
  return 0;
};

export function QuickOpen({ open, entries, onClose }: Props) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);

  const filteredEntries = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return entries
      .map((entry) => ({ entry, score: scoreEntry(entry, normalizedQuery) }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score || a.entry.title.localeCompare(b.entry.title))
      .slice(0, 14)
      .map(({ entry }) => entry);
  }, [entries, query]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActiveIndex(0);
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }, [open]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  if (!open) return null;

  const runEntry = (entry: QuickOpenEntry | undefined) => {
    if (!entry) return;
    void entry.run();
    onClose();
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((current) => Math.min(current + 1, Math.max(filteredEntries.length - 1, 0)));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((current) => Math.max(current - 1, 0));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      runEntry(filteredEntries[activeIndex]);
    }
  };

  return (
    <div
      className="quick-open-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section className="quick-open" role="dialog" aria-modal="true" aria-label="Quick open">
        <div className="quick-open-input-row">
          <input
            ref={inputRef}
            value={query}
            placeholder="Search workspaces, agents, messages, commands"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
          />
          <kbd>Esc</kbd>
        </div>

        <div className="quick-open-list" role="listbox" aria-label="Quick open results">
          {filteredEntries.map((entry, index) => (
            <button
              className={`quick-open-item ${index === activeIndex ? "is-active" : ""}`}
              key={entry.id}
              onClick={() => runEntry(entry)}
              onMouseEnter={() => setActiveIndex(index)}
              role="option"
              type="button"
              aria-selected={index === activeIndex}
            >
              <span className={`quick-open-kind is-${entry.kind}`}>{kindLabels[entry.kind]}</span>
              <span className="quick-open-copy">
                <strong>{entry.title}</strong>
                {entry.subtitle ? <small>{entry.subtitle}</small> : null}
              </span>
            </button>
          ))}
          {filteredEntries.length === 0 ? (
            <div className="quick-open-empty">
              <strong>No match</strong>
              <span>Try an agent, workspace, message, or command.</span>
            </div>
          ) : null}
        </div>
      </section>
    </div>
  );
}
