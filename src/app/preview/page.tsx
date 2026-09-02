import { notFound } from 'next/navigation';
import { ChatPanel } from '@/components/chat/ChatPanel';
import { BillsCard } from '@/components/dashboard/BillsCard';
import { HeroCard } from '@/components/dashboard/HeroCard';
import { TransactionsCard } from '@/components/dashboard/TransactionsCard';
import { daysUntil, isOverdue, monthLabel } from '@/lib/dates';
import type { BillOccurrence, Category, Member, MonthSummary, Transaction } from '@/lib/types';

/**
 * Bancada de revisão de design. Renderiza o dashboard com dados fictícios, sem
 * tocar em banco nem em sessão — é como a UI pode ser avaliada antes de existir
 * um Supabase configurado.
 *
 * Só existe em desenvolvimento. Em produção, 404: uma tela com números
 * inventados num app financeiro é exatamente o tipo de coisa que não pode
 * escapar para o ambiente real.
 */
export const dynamic = 'force-dynamic';

const TODAY = '2026-09-02';

const CATEGORIES: Record<string, Category> = {
  energia: { id: 'c1', key: 'energia', label: 'Energia', isBill: true },
  internet: { id: 'c2', key: 'internet', label: 'Internet', isBill: true },
  cartao: { id: 'c3', key: 'cartao', label: 'Cartão de crédito', isBill: true },
  mercado: { id: 'c4', key: 'mercado', label: 'Mercado', isBill: false },
  delivery: { id: 'c5', key: 'delivery', label: 'Delivery', isBill: false },
  farmacia: { id: 'c6', key: 'farmacia', label: 'Farmácia', isBill: false },
};

const RAONI: Member = { id: 'm1', displayName: 'Raoni', role: 'admin' };
const CAMILA: Member = { id: 'm2', displayName: 'Camila', role: 'member' };

function bill(
  id: string,
  title: string,
  amountCents: number,
  dueDate: string,
  category: Category,
  responsible: Member | null,
): BillOccurrence {
  return {
    id,
    billId: `b-${id}`,
    title,
    amountCents,
    dueDate,
    status: 'pending',
    category,
    responsible,
    isOverdue: isOverdue(dueDate, TODAY, 'pending'),
    daysUntilDue: daysUntil(dueDate, TODAY),
  };
}

const BILLS: BillOccurrence[] = [
  bill('o3', 'Cartão', 120400, '2026-08-31', CATEGORIES['cartao']!, RAONI),
  bill('o1', 'Energia', 34000, '2026-09-05', CATEGORIES['energia']!, RAONI),
  bill('o2', 'Internet', 12990, '2026-09-08', CATEGORIES['internet']!, null),
];

const TRANSACTIONS: Transaction[] = [
  {
    id: 't1',
    kind: 'expense',
    amountCents: 21840,
    occurredOn: '2026-09-01',
    description: null,
    category: CATEGORIES['mercado']!,
    spentBy: CAMILA,
  },
  {
    id: 't2',
    kind: 'expense',
    amountCents: 6490,
    occurredOn: '2026-09-01',
    description: null,
    category: CATEGORIES['delivery']!,
    spentBy: RAONI,
  },
  {
    id: 't3',
    kind: 'expense',
    amountCents: 9210,
    occurredOn: '2026-08-31',
    description: null,
    category: CATEGORIES['farmacia']!,
    spentBy: CAMILA,
  },
  {
    id: 't4',
    kind: 'income',
    amountCents: 480000,
    occurredOn: '2026-08-30',
    description: 'Freela',
    category: null,
    spentBy: RAONI,
  },
];

const SUMMARY: MonthSummary = {
  month: '2026-09-01',
  spentCents: 348290,
  duePendingCents: 167390,
  duePaidCents: 224200,
  budgetCents: 750000,
  remainingCents: 750000 - 348290 - 167390,
};

export default function PreviewPage() {
  if (process.env.NODE_ENV === 'production') notFound();

  return (
    <main className="dashboard-shell mx-auto min-h-dvh w-full max-w-5xl px-4 pb-28 lg:px-6">
      <header className="flex h-14 items-center justify-between">
        <h1 className="text-[15px] font-medium">{monthLabel(TODAY)}</h1>
        <span className="flex h-8 w-8 items-center justify-center rounded-full border border-line bg-surface text-[13px] font-medium text-dim">
          RM
        </span>
      </header>

      <div className="space-y-6">
        <HeroCard summary={SUMMARY} />
        <div className="grid gap-6 lg:grid-cols-2">
          <BillsCard bills={BILLS} today={TODAY} />
          <TransactionsCard transactions={TRANSACTIONS} today={TODAY} />
        </div>
      </div>

      <ChatPanel displayName="Raoni" />
    </main>
  );
}
