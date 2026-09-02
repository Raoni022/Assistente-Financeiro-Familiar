import { Card, SectionTitle } from '@/components/ui/Card';
import { Money } from '@/components/ui/Money';
import { dueLabel, type IsoDate } from '@/lib/dates';
import type { BillOccurrence } from '@/lib/types';

export function BillsCard({ bills, today }: { bills: BillOccurrence[]; today: IsoDate }) {
  return (
    <section>
      <SectionTitle>Próximos vencimentos</SectionTitle>
      <Card>
        {bills.length === 0 ? (
          <p className="py-2 text-[15px] text-dim">
            Nenhuma conta cadastrada ainda. Peça ao assistente: “cadastra a conta de luz, R$ 340, todo dia 15”.
          </p>
        ) : (
          <ul>
            {bills.map((bill, index) => (
              <li
                key={bill.id}
                className={index > 0 ? 'border-t border-line pt-3 mt-3' : ''}
              >
                <BillRow bill={bill} today={today} />
              </li>
            ))}
          </ul>
        )}
      </Card>
    </section>
  );
}

function BillRow({ bill, today }: { bill: BillOccurrence; today: IsoDate }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="flex min-w-0 items-start gap-2.5">
        {/*
          Estado nunca é carregado só por cor (docs/design.md §1): o marcador
          muda de forma, a cor muda, e a palavra "vencida" aparece no rótulo.
          Quem não distingue vermelho de dourado ainda entende a lista.
        */}
        <span
          aria-hidden
          className={`mt-1.5 text-[10px] leading-none ${bill.isOverdue ? 'text-negative' : 'text-accent'}`}
        >
          {bill.isOverdue ? '▲' : '●'}
        </span>
        <div className="min-w-0">
          <p className="truncate text-[15px]">{bill.title}</p>
          <p className={`text-[13px] ${bill.isOverdue ? 'text-negative' : 'text-dim'}`}>
            {dueLabel(bill.dueDate, today)}
            {bill.responsible ? ` · ${bill.responsible.displayName}` : ''}
          </p>
        </div>
      </div>
      <p className="shrink-0 text-[16px] font-medium">
        <Money cents={bill.amountCents} />
      </p>
    </div>
  );
}
