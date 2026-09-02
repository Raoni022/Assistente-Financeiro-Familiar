import { Card } from '@/components/ui/Card';
import { Money } from '@/components/ui/Money';
import { monthLabel } from '@/lib/dates';
import type { MonthSummary } from '@/lib/types';

/**
 * Card herói: único elemento em peso 600/40px da tela. Raio 20 contra os 14 dos
 * cards de lista — hierarquia por forma, não só por tamanho (docs/design.md §3).
 */
export function HeroCard({ summary }: { summary: MonthSummary }) {
  const { spentCents, duePendingCents, duePaidCents, budgetCents, remainingCents } = summary;

  const usedCents = spentCents + duePendingCents;
  const pct = budgetCents && budgetCents > 0 ? Math.min(100, (usedCents / budgetCents) * 100) : null;
  const overBudget = pct !== null && usedCents > budgetCents!;

  return (
    <Card weight="hero">
      <p className="text-[13px] font-medium uppercase tracking-[0.04em] text-dim">
        Gasto em {monthLabel(summary.month).toLowerCase()}
      </p>

      <p className="mt-2 text-[40px] font-semibold leading-none">
        <Money cents={spentCents} />
      </p>

      {pct === null ? (
        <p className="mt-3 text-[13px] text-dim">
          Sem orçamento definido para o mês.
        </p>
      ) : (
        <div className="mt-4">
          <div
            className="h-1.5 w-full overflow-hidden rounded-full bg-line"
            role="progressbar"
            aria-valuenow={Math.round(pct)}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Percentual do orçamento previsto já comprometido"
          >
            <div
              className={overBudget ? 'h-full bg-negative' : 'h-full bg-accent'}
              style={{ width: `${pct}%` }}
            />
          </div>
          <p className="mt-2 text-[13px] text-dim">
            {Math.round(pct)}% do previsto
            {overBudget ? ' · acima do orçamento' : ''}
          </p>
        </div>
      )}

      <dl className="mt-5 grid grid-cols-3 gap-3 border-t border-line pt-4">
        <Stat label="a pagar" cents={duePendingCents} tone={duePendingCents > 0 ? 'attention' : 'plain'} />
        <Stat label="pago" cents={duePaidCents} tone="plain" />
        <Stat
          label="sobra"
          cents={remainingCents}
          tone={remainingCents !== null && remainingCents < 0 ? 'negative' : 'positive'}
        />
      </dl>
    </Card>
  );
}

function Stat({
  label,
  cents,
  tone,
}: {
  label: string;
  cents: number | null;
  tone: 'plain' | 'positive' | 'negative' | 'attention';
}) {
  const toneClass =
    tone === 'positive' ? 'text-positive' : tone === 'negative' ? 'text-negative' : 'text-text';

  return (
    <div>
      <dt className="text-[13px] text-dim">{label}</dt>
      <dd className={`mt-0.5 text-[16px] font-medium ${toneClass}`}>
        {/* Sem orçamento não há "sobra": um traço é honesto, um zero mentiria. */}
        {cents === null ? <span className="text-dim">—</span> : <Money cents={cents} compact />}
      </dd>
    </div>
  );
}
