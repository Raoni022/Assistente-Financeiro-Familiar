'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Chat flutuante: FAB + painel. Bottom sheet no mobile, painel lateral no
 * desktop — mesmo componente, mesma máquina de estados, só a apresentação muda
 * por media query (docs/design.md §4.3).
 *
 * FASE 1: shell visual apenas. O input está desabilitado de propósito — a
 * ligação com o grafo do LangGraph entra na Fase 2. Um input que aceita texto e
 * não faz nada é pior que um input honestamente desabilitado.
 */
export function ChatPanel({ displayName }: { displayName: string }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);

  const openPanel = useCallback(() => {
    // showModal() dá foco preso, Esc e retorno de foco ao FAB de graça.
    dialogRef.current?.showModal();
    setOpen(true);
  }, []);

  const closePanel = useCallback(() => {
    dialogRef.current?.close();
  }, []);

  // O sheet ocupa a tela no mobile: travar o scroll do fundo evita o efeito de
  // "rolar o dashboard por baixo" ao arrastar dentro do chat.
  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

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
            {/* Handle de arraste: afordância de bottom sheet, só no mobile. */}
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

          <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
            <div className="rounded-item bg-raised p-4">
              <p className="text-[15px]">
                Oi, {displayName}. Ainda não estou ligado aos agentes — isso entra na próxima fase.
              </p>
              <p className="mt-2 text-[13px] text-dim">
                Quando estiver, você vai poder dizer coisas como “gastei 80 no mercado hoje” ou
                “cadastra a conta de luz pro dia 15”, e o dashboard atrás atualiza na hora.
              </p>
            </div>
          </div>

          <footer
            className="shrink-0 border-t border-line p-3"
            style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}
          >
            <div className="flex items-center gap-2 rounded-item border border-line-strong bg-bg px-3 py-2.5 opacity-50">
              <input
                type="text"
                disabled
                placeholder="Disponível na Fase 2"
                aria-label="Mensagem para o assistente"
                className="min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-dim"
              />
              <span aria-hidden className="text-dim">
                <SendIcon />
              </span>
            </div>
          </footer>
        </div>
      </dialog>
    </>
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
