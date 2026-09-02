'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { formatCents } from '@/lib/money';
import { shortDate } from '@/lib/dates';

/**
 * Chat flutuante: FAB + painel. Bottom sheet no mobile, painel lateral no
 * desktop — mesmo componente, mesma máquina de estados, só a apresentação muda
 * por media query (docs/design.md §4.3).
 */

interface BillCardBlock {
  type: 'bill_card';
  occurrenceId: string;
  title: string;
  amountCents: number;
  dueDate: string;
  status: 'pending' | 'paid' | 'cancelled';
}

interface TransactionCardBlock {
  type: 'transaction_card';
  transactionId: string;
  label: string;
  amountCents: number;
  occurredOn: string;
}

type Block = BillCardBlock | TransactionCardBlock | { type: string; [key: string]: unknown };

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  blocks?: Block[];
  failed?: boolean;
}

const GREETING: Message = {
  id: 'greeting',
  role: 'assistant',
  content:
    'Oi. Posso cadastrar contas, registrar gastos e dizer para onde o dinheiro foi. Fale como falaria com alguém: "gastei 80 no mercado hoje" ou "cadastra a conta de luz, 340, todo dia 15".',
};

export function ChatPanel({ displayName }: { displayName: string }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([GREETING]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const conversationId = useRef<string | null>(null);

  const openPanel = useCallback(() => {
    // showModal() dá foco preso, Esc e retorno de foco ao FAB de graça.
    dialogRef.current?.showModal();
    setOpen(true);
  }, []);

  const closePanel = useCallback(() => dialogRef.current?.close(), []);

  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    inputRef.current?.focus();
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, sending]);

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text || sending) return;

    setDraft('');
    setSending(true);
    setMessages((current) => [
      ...current,
      { id: crypto.randomUUID(), role: 'user', content: text },
    ]);

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, conversationId: conversationId.current }),
      });

      const body = (await response.json()) as {
        conversationId?: string;
        text?: string;
        blocks?: Block[];
        touched?: string[];
        error?: string;
      };

      if (!response.ok) {
        setMessages((current) => [
          ...current,
          {
            id: crypto.randomUUID(),
            role: 'assistant',
            content: body.error ?? 'Não consegui responder agora.',
            failed: true,
          },
        ]);
        return;
      }

      if (body.conversationId) conversationId.current = body.conversationId;

      setMessages((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: body.text ?? '',
          ...(body.blocks && body.blocks.length > 0 ? { blocks: body.blocks } : {}),
        },
      ]);

      /*
       * O dashboard atrás precisa refletir a ação na hora — é o que faz o
       * sistema parecer vivo em vez de dois apps colados (brief §4.1).
       * `router.refresh()` re-renderiza os Server Components com os dados novos
       * sem descartar o estado desta conversa.
       */
      if (body.touched && body.touched.length > 0) router.refresh();
    } catch {
      setMessages((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: 'Perdi a conexão no meio do caminho. Tente de novo.',
          failed: true,
        },
      ]);
    } finally {
      setSending(false);
      inputRef.current?.focus();
    }
  }, [draft, sending, router]);

  return (
    <>
      <button
        type="button"
        onClick={openPanel}
        aria-label="Abrir conversa com o assistente"
        aria-haspopup="dialog"
        className="fixed right-5 z-40 flex h-14 w-14 items-center justify-center rounded-full bg-accent text-accent-ink shadow-[0_8px_24px_-6px_rgb(201_168_118/0.45)] transition-transform active:scale-95"
        style={{ bottom: 'max(1.25rem, env(safe-area-inset-bottom))' }}
      >
        <SparkIcon />
      </button>

      <dialog
        ref={dialogRef}
        className="chat-dialog"
        aria-label="Conversa com o assistente"
        onClose={() => setOpen(false)}
      >
        <div className="flex h-full flex-col rounded-t-[20px] border border-line bg-surface lg:rounded-none lg:border-y-0 lg:border-r-0">
          <header className="shrink-0 px-4 pb-3 pt-2">
            <div aria-hidden className="mx-auto mb-3 h-1 w-9 rounded-full bg-line lg:hidden" />
            <div className="flex items-center justify-between">
              <p className="text-[15px] font-medium">Assistente</p>
              <button
                type="button"
                onClick={closePanel}
                aria-label="Fechar conversa"
                className="-mr-2 flex h-11 w-11 items-center justify-center rounded-item text-dim transition-colors hover:text-text"
              >
                <CloseIcon />
              </button>
            </div>
          </header>

          <div
            ref={scrollRef}
            className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 pb-4"
            aria-live="polite"
            aria-busy={sending}
          >
            {messages.map((message) => (
              <MessageBubble key={message.id} message={message} name={displayName} />
            ))}
            {sending && <Thinking />}
          </div>

          <footer
            className="shrink-0 border-t border-line p-3"
            style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}
          >
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void send();
              }}
              className="flex items-center gap-2 rounded-item border border-line-strong bg-bg px-3 py-2.5 focus-within:border-accent"
            >
              <input
                ref={inputRef}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                disabled={sending}
                placeholder="Escreva…"
                aria-label="Mensagem para o assistente"
                className="min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-dim disabled:opacity-50"
              />
              <button
                type="submit"
                disabled={sending || draft.trim().length === 0}
                aria-label="Enviar"
                className="text-accent transition-opacity disabled:text-dim disabled:opacity-50"
              >
                <SendIcon />
              </button>
            </form>
          </footer>
        </div>
      </dialog>
    </>
  );
}

function MessageBubble({ message, name }: { message: Message; name: string }) {
  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <p className="max-w-[85%] rounded-item bg-accent/15 px-3 py-2 text-[15px]">
          {message.content}
        </p>
      </div>
    );
  }

  return (
    <div className="flex justify-start">
      <div
        className={`max-w-[92%] rounded-item px-3 py-2 ${
          message.failed ? 'border border-negative/40 bg-raised' : 'bg-raised'
        }`}
      >
        <p className={`whitespace-pre-wrap text-[15px] ${message.failed ? 'text-negative' : ''}`}>
          {message.id === 'greeting' ? `Oi, ${name}. ${message.content.slice(4)}` : message.content}
        </p>
        {message.blocks?.map((block, index) => {
          if (block.type === 'bill_card') {
            return <BillCard key={`bill-${index}`} block={block as BillCardBlock} />;
          }
          if (block.type === 'transaction_card') {
            return <TransactionCard key={`tx-${index}`} block={block as TransactionCardBlock} />;
          }
          return null;
        })}
      </div>
    </div>
  );
}

/** Card inline: o que o brief chama de "informação bem organizada", não só texto. */
function BillCard({ block }: { block: BillCardBlock }) {
  return (
    <div className="mt-2 rounded-[8px] border border-line bg-surface px-3 py-2">
      <div className="flex items-baseline justify-between gap-3">
        <span className="truncate text-[15px]">{block.title}</span>
        <span className="money shrink-0 text-[15px] font-medium">
          {formatCents(block.amountCents)}
        </span>
      </div>
      <p className="mt-0.5 text-[13px] text-dim">
        {block.status === 'paid' ? 'paga · ' : 'vence '}
        {shortDate(block.dueDate)}
      </p>
    </div>
  );
}

function TransactionCard({ block }: { block: TransactionCardBlock }) {
  return (
    <div className="mt-2 rounded-[8px] border border-line bg-surface px-3 py-2">
      <div className="flex items-baseline justify-between gap-3">
        <span className="truncate text-[15px]">{block.label}</span>
        <span className="money shrink-0 text-[15px] font-medium">
          {formatCents(block.amountCents)}
        </span>
      </div>
      <p className="mt-0.5 text-[13px] text-dim">{shortDate(block.occurredOn)}</p>
    </div>
  );
}

function Thinking() {
  return (
    <div className="flex justify-start">
      <p className="rounded-item bg-raised px-3 py-2 text-[15px] text-dim">Pensando…</p>
    </div>
  );
}

function SparkIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M12 2l1.9 6.1L20 10l-6.1 1.9L12 18l-1.9-6.1L4 10l6.1-1.9L12 2z" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
      <path d="M18 6L6 18M6 6l12 12" />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M3 20l18-8L3 4v6l12 2-12 2v6z" />
    </svg>
  );
}
