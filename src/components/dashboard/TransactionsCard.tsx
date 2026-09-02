import { Card, SectionTitle } from '@/components/ui/Card';
import { Money } from '@/components/ui/Money';
import { relativeDayLabel, type IsoDate } from '@/lib/dates';
import type { Transaction } from '@/lib/types';

export function TransactionsCard({
  transactions,
  today,
}: {
  transactions: Transaction[];
  today: IsoDate;
}) {
  return (
    <section>
      <SectionTitle>Últimos gastos</SectionTitle>
      <Card>
        {transactions.length === 0 ? (
          <p className="py-2 text-[15px] text-dim">
            Nada registrado ainda. Peça ao assistente: “gastei 80 reais no mercado hoje”.
          </p>
        ) : (
          <ul>
            {transactions.map((tx, index) => (
              <li
                key={tx.id}
                className={`flex items-start justify-between gap-3 ${
                  index > 0 ? 'border-t border-line pt-3 mt-3' : ''
                }`}
              >
                <div className="min-w-0">
                  <p className="truncate text-[15px]">
                    {tx.category?.label ?? tx.description ?? 'Sem categoria'}
                  </p>
                  <p className="text-[13px] text-dim">
                    {relativeDayLabel(tx.occurredOn, today)}
                    {tx.spentBy ? ` · ${tx.spentBy.displayName}` : ''}
                  </p>
                </div>
                <p
                  className={`shrink-0 text-[16px] font-medium ${
                    tx.kind === 'income' ? 'text-positive' : ''
                  }`}
                >
                  {tx.kind === 'income' ? '+' : ''}
                  <Money cents={tx.amountCents} pulse={false} />
                </p>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </section>
  );
}
