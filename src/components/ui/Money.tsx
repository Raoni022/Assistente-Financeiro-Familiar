'use client';

import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/cn';
import { formatCents, formatCentsCompact, type Cents } from '@/lib/money';

/**
 * Valor monetário. Sempre tabular — é o detalhe que faz colunas de número
 * alinharem e o app parecer preciso (docs/design.md §2).
 *
 * Quando o valor muda depois de uma ação do agente, dá um pulso de fundo na cor
 * `positive`/`negative` conforme a direção. Só fundo: não desloca layout, não
 * redesenha o número. É o sinal de "o dashboard está vivo" pedido no brief §4.1.
 */
export function Money({
  cents,
  compact = false,
  className,
  /** Desliga o pulso onde a mudança não é notícia (ex: lista paginada). */
  pulse = true,
}: {
  cents: Cents;
  compact?: boolean;
  className?: string;
  pulse?: boolean;
}) {
  const previous = useRef<Cents | null>(null);
  const [direction, setDirection] = useState<'up' | 'down' | null>(null);

  useEffect(() => {
    // Primeira renderização não é mudança — não pulsa ao abrir a tela.
    if (previous.current === null) {
      previous.current = cents;
      return;
    }
    if (previous.current === cents) return;

    setDirection(cents > previous.current ? 'up' : 'down');
    previous.current = cents;

    const timer = setTimeout(() => setDirection(null), 600);
    return () => clearTimeout(timer);
  }, [cents]);

  return (
    <span
      className={cn('money', direction && 'value-pulse', className)}
      style={
        direction
          ? ({
              // Gasto que sobe é ruim; valor que cai (uma dívida, por exemplo)
              // é bom. Quem chama decide o sinal invertendo os papéis se
              // precisar — aqui a leitura padrão é "gasto".
              '--pulse-color': direction === 'up' ? 'var(--color-negative)' : 'var(--color-positive)',
            } as React.CSSProperties)
          : undefined
      }
    >
      {compact ? formatCentsCompact(cents) : formatCents(cents)}
    </span>
  );
}
