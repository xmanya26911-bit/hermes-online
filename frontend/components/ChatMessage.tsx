"use client";

import { memo, useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import type { ChatMessage, ToolActivity } from "../lib/protocol";

function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="group/code relative my-2 overflow-hidden rounded-lg border border-ink-700 bg-black/50">
      <div className="flex items-center justify-between border-b border-ink-700/60 px-3 py-1">
        <span className="font-mono text-[10px] uppercase tracking-wider text-slate-500">{lang || "code"}</span>
        <button
          onClick={() => {
            void navigator.clipboard.writeText(code).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
          className="rounded px-1.5 py-0.5 font-mono text-[10px] text-slate-400 hover:bg-ink-700 hover:text-accent-400"
        >
          {copied ? "copied ✓" : "copy"}
        </button>
      </div>
      <pre className="overflow-x-auto p-3 font-mono text-[12.5px] leading-relaxed">
        <code>{code}</code>
      </pre>
    </div>
  );
}

const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="prose-hermes text-[14px] leading-relaxed">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          pre({ children, ...rest }) {
            return <>{children}</>;
          },
          code(props) {
            const { className, children } = props as { className?: string; children?: React.ReactNode };
            const raw = String(children ?? "").replace(/\n$/, "");
            const isBlock = (className ?? "").includes("language-") || raw.includes("\n");
            if (!isBlock) {
              return <code className="rounded bg-ink-700/70 px-1 py-0.5 font-mono text-[12.5px] text-accent-400">{children}</code>;
            }
            const lang = (className ?? "").replace("language-", "").replace("hljs ", "").split(" ")[0] ?? "";
            return <CodeBlock code={raw} lang={lang} />;
          },
          a({ href, children }) {
            return (
              <a href={href} target="_blank" rel="noreferrer" className="text-accent-400 underline decoration-accent-600/50">
                {children}
              </a>
            );
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});

export function ActivityFeed({ items }: { items: ToolActivity[] }) {
  if (items.length === 0) return null;
  return (
    <div className="mb-2 space-y-1">
      {items.map((a) => (
        <div key={a.id} className="flex items-center gap-2 text-xs text-slate-400">
          <span
            className={`inline-block h-1.5 w-1.5 rounded-full ${
              a.state === "running" ? "animate-pulse bg-accent-400" : a.state === "error" ? "bg-red-400" : "bg-slate-600"
            }`}
          />
          <span className="font-medium text-slate-300">{a.label}</span>
          {a.detail ? <span className="truncate font-mono text-[11px] text-slate-500">{a.detail}</span> : null}
        </div>
      ))}
    </div>
  );
}

export default memo(function ChatMessageView({ message }: { message: ChatMessage }) {
  const isUser = message.role === "user";
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[92%] rounded-2xl px-4 py-3 md:max-w-[80%] ${
          isUser ? "bg-accent-600/90 text-white" : "border border-ink-700 bg-ink-900 text-slate-100"
        }`}
      >
        <div className={`mb-1 font-mono text-[10px] uppercase tracking-widest ${isUser ? "text-white/70" : "text-slate-500"}`}>
          {isUser ? "you" : "hermes"}
          {message.streaming ? <span className="ml-2 animate-pulse">●</span> : null}
        </div>
        {isUser ? (
          <div className="whitespace-pre-wrap text-[14px]">{message.text}</div>
        ) : (
          <Markdown text={message.text || "…"} />
        )}
      </div>
    </div>
  );
});
