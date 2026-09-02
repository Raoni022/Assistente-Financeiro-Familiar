import Link from 'next/link';
import { ChatPanel } from '@/components/chat/ChatPanel';
import { BillsCard } from '@/components/dashboard/BillsCard';
import { HeroCard } from '@/components/dashboard/HeroCard';
import { TransactionsCard } from '@/components/dashboard/TransactionsCard';
import { monthLabel, todayInTz } from '@/lib/dates';
import { requireHousehold } from '@/server/auth/session';
import { createClient } from '@/server/db/server';
import {
  getAttentionBills,
  getMonthSummary,
  getRecentTransactions,
} from '@/server/db/queries/dashboard';

// Dado financeiro muda a cada ação do agente: nada aqui pode ser servido de
// cache estático.
export const dynamic = 'force-dynamic';

export default async function DashboardPage() {
  const session = await requireHousehold();

  // "Hoje" é o dia civil da família, não o do servidor da Vercel (que roda UTC).
  const today = todayInTz(session.timezone);

  const supabase = await createClient();
  const { data: household } = await supabase
    .from('households')
    .select('monthly_budget_cents')
    .eq('id', session.householdId)
    .maybeSingle();

  const budgetCents = (household?.monthly_budget_cents as number | null) ?? null;

  const [summary, bills, transactions] = await Promise.all([
    getMonthSummary(today, budgetCents),
    getAttentionBills(today),
    getRecentTransactions(),
  ]);

  return (
    <main className="dashboard-shell mx-auto min-h-dvh w-full max-w-5xl px-4 pb-28 lg:px-6">
      <header className="flex h-14 items-center justify-between">
        <h1 className="text-[15px] font-medium">{monthLabel(today)}</h1>
        <Link
          href="/familia"
          aria-label={`Casa e conta de ${session.displayName}`}
          className="flex h-11 w-11 items-center justify-center rounded-full text-dim transition-colors hover:text-text"
        >
          <span className="flex h-8 w-8 items-center justify-center rounded-full border border-line bg-surface text-[13px] font-medium">
            {initials(session.displayName)}
          </span>
        </Link>
      </header>

      <div className="space-y-6">
        <HeroCard summary={summary} />

        {/* Desktop ganha duas colunas; mobile permanece uma. Não é o mobile
            esticado nem um layout novo — docs/design.md §4.3. */}
        <div className="grid gap-6 lg:grid-cols-2">
          <BillsCard bills={bills} today={today} />
          <TransactionsCard transactions={transactions} today={today} />
        </div>
      </div>

      <ChatPanel displayName={session.displayName.split(' ')[0] ?? session.displayName} />
    </main>
  );
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  const first = parts[0]?.[0] ?? '?';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';
  return (first + last).toUpperCase();
}
