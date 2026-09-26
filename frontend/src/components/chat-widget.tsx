"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ArrowUp, MessageSquare, ThumbsDown, ThumbsUp, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api, DATASET_KEY } from "@/lib/api";
import { cn } from "@/lib/utils";

type Msg = {
  role: "user" | "assistant";
  content: string;
  id?: string;
  ok?: boolean;
  vote?: boolean;
};

const STARTERS = [
  "Summarise the findings that can stop the line",
  "Which AP radios are silent, and since when?",
  "How does the pipeline scale to 1,000 sensors?",
];

const SESSION_KEY = "airframe.chat.session";

function read(key: string) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function sessionId() {
  const cur = read(SESSION_KEY);
  if (cur) return cur;
  const id =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2) + Date.now().toString(36);
  try {
    localStorage.setItem(SESSION_KEY, id);
  } catch {
    // storage blocked: a fresh id per page load is fine
  }
  return id;
}

export function ChatWidget() {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    list.current?.scrollTo({
      top: list.current.scrollHeight,
      behavior: "smooth",
    });
  }, [msgs, busy]);

  useEffect(() => {
    if (!open) return;
    field.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  async function send(text: string) {
    const question = text.trim();
    if (!question || busy) return;
    const history = msgs.map(({ role, content }) => ({ role, content }));
    setMsgs((m) => [...m, { role: "user", content: question }]);
    setInput("");
    setBusy(true);
    try {
      const r = await api.chat({
        question,
        session: sessionId(),
        page: path,
        dataset_id: read(DATASET_KEY),
        history: history.slice(-12),
      });
      setMsgs((m) => [
        ...m,
        { role: "assistant", content: r.answer, id: r.id, ok: r.ok },
      ]);
    } catch {
      setMsgs((m) => [
        ...m,
        {
          role: "assistant",
          content:
            "The assistant is not available. Try again later.",
          ok: false,
        },
      ]);
    } finally {
      setBusy(false);
    }
  }

  function vote(i: number, helpful: boolean) {
    const m = msgs[i];
    if (!m.id || m.vote !== undefined) return;
    setMsgs((all) =>
      all.map((x, k) => (k === i ? { ...x, vote: helpful } : x)),
    );
    api.chatFeedback(m.id, helpful).catch(() => undefined);
  }

  return (
    <>
      <button
        onClick={() => setOpen((o) => !o)}
        aria-label={open ? "Close assistant" : "Ask the Gearbox assistant"}
        aria-expanded={open}
        className={cn(
          "print:hidden bg-card hover:bg-muted fixed right-4 bottom-4 z-50 flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium transition-colors sm:right-6 sm:bottom-4",
          open && "max-sm:hidden",
        )}
      >
        {open ? <X className="size-3.5" /> : <MessageSquare className="size-3.5" />}
        Assistant
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Gearbox assistant"
          className="print:hidden bg-popover fixed inset-x-0 bottom-0 z-50 flex h-[85dvh] flex-col overflow-hidden rounded-t-md border shadow-xl sm:inset-x-auto sm:right-6 sm:bottom-14 sm:h-[min(620px,calc(100dvh-8rem))] sm:w-[400px] sm:rounded-md"
        >
          <div className="flex items-center gap-3 border-b px-3 py-2">
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-semibold">Assistant</div>
              <div className="text-muted-foreground text-xs">
                It uses the current dataset and the docs
              </div>
            </div>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Close"
              onClick={() => setOpen(false)}
            >
              <X />
            </Button>
          </div>

          <div
            ref={list}
            className="scrollbar-thin flex-1 space-y-3 overflow-y-auto px-3 py-3"
          >
            {msgs.length === 0 && (
              <div className="space-y-2">
                <p className="text-muted-foreground text-xs">Examples:</p>
                <div className="flex flex-col items-start gap-1">
                  {STARTERS.map((q) => (
                    <button
                      key={q}
                      onClick={() => send(q)}
                      className="hover:bg-muted rounded-sm border px-2.5 py-1.5 text-left text-xs transition-colors"
                    >
                      {q}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {msgs.map((m, i) =>
              m.role === "user" ? (
                <div key={i} className="flex justify-end">
                  <div className="bg-muted max-w-[85%] rounded-md px-3 py-1.5 text-[13px] whitespace-pre-wrap">
                    {m.content}
                  </div>
                </div>
              ) : (
                <div key={i} className="space-y-1.5">
                  <div
                    className={cn(
                      "prose prose-sm dark:prose-invert max-w-none text-[13px]",
                      "prose-p:my-1.5 prose-ul:my-1.5 prose-ol:my-1.5 prose-li:my-0.5 prose-headings:my-2 prose-pre:bg-muted prose-pre:text-foreground prose-code:before:content-none prose-code:after:content-none prose-code:rounded prose-code:bg-muted prose-code:px-1 prose-code:font-normal prose-a:text-calm dark:prose-pre:bg-black/30 dark:prose-code:bg-white/10 dark:prose-a:text-sky-300",
                      m.ok === false && "text-red-700 dark:text-red-300",
                    )}
                  >
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                      {m.content}
                    </ReactMarkdown>
                  </div>
                  {m.id && (
                    <div className="text-muted-foreground flex items-center gap-1 pl-1 text-xs">
                      {m.vote === undefined ? (
                        <>
                          <span className="mr-1">Is this answer helpful?</span>
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            aria-label="Helpful"
                            onClick={() => vote(i, true)}
                          >
                            <ThumbsUp />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            aria-label="Not helpful"
                            onClick={() => vote(i, false)}
                          >
                            <ThumbsDown />
                          </Button>
                        </>
                      ) : (
                        <span className="flex items-center gap-1">
                          {m.vote ? (
                            <ThumbsUp className="text-ok size-3" />
                          ) : (
                            <ThumbsDown className="size-3 text-red-600 dark:text-red-400" />
                          )}
                          Thank you for the feedback
                        </span>
                      )}
                    </div>
                  )}
                </div>
              ),
            )}
            {busy && (
              <div className="text-muted-foreground pl-1 font-mono text-xs">
                generating…
              </div>
            )}
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              send(input);
            }}
            className="border-t p-3"
          >
            <div className="bg-input/30 focus-within:border-ring flex items-end gap-2 rounded-md border px-2.5 py-1.5">
              <textarea
                ref={field}
                rows={1}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    send(input);
                  }
                }}
                placeholder="Ask a question…"
                className="placeholder:text-muted-foreground max-h-32 min-h-6 flex-1 resize-none bg-transparent text-sm outline-none field-sizing-content"
              />
              <Button
                type="submit"
                size="icon-sm"
                aria-label="Send"
                disabled={!input.trim() || busy}
              >
                <ArrowUp />
              </Button>
            </div>
            <p className="text-muted-foreground mt-1.5 text-[11px]">
              Gearbox keeps a log of the questions.
            </p>
          </form>
        </div>
      )}
    </>
  );
}
