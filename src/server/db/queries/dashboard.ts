import 'server-only';
import { createClient } from '@/server/db/server';
import { daysUntil, isOverdue, monthRange, type IsoDate } from '@/lib/dates';
import { sumCents } from '@/lib/money';
import type {
  BillOccurrence,
  Task,
  TaskStatus,
  Category,
  Member,
  MonthSummary,
  OccurrenceStatus,
  Transaction,
  TransactionKind,
} from '@/lib/types';

/**
 * Queries do dashboard.
 *
 * Nota sobre agregação: os totais são somados em JS, com `sumCents`, e não com
 * SUM() no Postgres. Isso é deliberado no volume de uma família — algumas
 * centenas de linhas por mês — e mantém toda aritmética monetária dentro da
 * função inteira já coberta por teste. Se um dia isso pesar, o caminho é uma
 * RPC agregando em `bigint`, nunca `numeric` lido como float no cliente.
 *
 * Todas as queries daqui usam o cliente com JWT do usuário: a RLS filtra por
 * household. Nenhuma passa household_id explícito — se a RLS falhar, o teste de
 * isolamento é que precisa gritar, não um filtro redundante escondendo o furo.
 */

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>;

export async function getMembers(supabase: SupabaseServerClient): Promise<Map<string, Member>> {
  const { data, error } = await supabase.from('profiles').select('id, display_name, role');
  if (error) throw new Error(`Falha ao carregar membros: ${error.message}`);

  return new Map(
    (data ?? []).map((row) => [
      row.id as string,
      { id: row.id as string, displayName: row.display_name as string, role: row.role as Member['role'] },
    ]),
  );
}

export async function getCategories(supabase: SupabaseServerClient): Promise<Map<string, Category>> {
  const { data, error } = await supabase.from('categories').select('id, key, label, is_bill');
  if (error) throw new Error(`Falha ao carregar categorias: ${error.message}`);

  return new Map(
    (data ?? []).map((row) => [
      row.id as string,
      {
        id: row.id as string,
        key: row.key as string,
        label: row.label as string,
        isBill: row.is_bill as boolean,
      },
    ]),
  );
}

interface OccurrenceRow {
  id: string;
  bill_id: string;
  due_date: string;
  amount_cents: number;
  status: OccurrenceStatus;
  bills: { title: string; category_id: string | null; responsible_id: string | null } | null;
}

function toBillOccurrence(
  row: OccurrenceRow,
  today: IsoDate,
  categories: Map<string, Category>,
  members: Map<string, Member>,
): BillOccurrence {
  const categoryId = row.bills?.category_id ?? null;
  const responsibleId = row.bills?.responsible_id ?? null;

  return {
    id: row.id,
    billId: row.bill_id,
    title: row.bills?.title ?? 'Conta',
    amountCents: row.amount_cents,
    dueDate: row.due_date,
    status: row.status,
    category: categoryId ? (categories.get(categoryId) ?? null) : null,
    responsible: responsibleId ? (members.get(responsibleId) ?? null) : null,
    // Derivados, nunca lidos do banco. Ver docs/architecture.md §4.
    isOverdue: isOverdue(row.due_date, today, row.status),
    daysUntilDue: daysUntil(row.due_date, today),
  };
}

/**
 * Contas que exigem atenção: as vencidas primeiro, depois as que vencem em
 * breve. Atrasada nunca some da lista por ser de mês anterior — é justamente a
 * que mais importa.
 */
export async function getAttentionBills(today: IsoDate, horizonDays = 30): Promise<BillOccurrence[]> {
  const supabase = await createClient();
  const [categories, members] = await Promise.all([getCategories(supabase), getMembers(supabase)]);

  const horizon = new Date(`${today}T00:00:00Z`);
  horizon.setUTCDate(horizon.getUTCDate() + horizonDays);
  const horizonIso = horizon.toISOString().slice(0, 10);

  const { data, error } = await supabase
    .from('bill_occurrences')
    .select('id, bill_id, due_date, amount_cents, status, bills ( title, category_id, responsible_id )')
    .eq('status', 'pending')
    .lte('due_date', horizonIso)
    .order('due_date', { ascending: true })
    .limit(50);

  if (error) throw new Error(`Falha ao carregar contas: ${error.message}`);

  return ((data ?? []) as unknown as OccurrenceRow[]).map((row) =>
    toBillOccurrence(row, today, categories, members),
  );
}

interface TransactionRow {
  id: string;
  kind: TransactionKind;
  amount_cents: number;
  occurred_on: string;
  description: string | null;
  category_id: string | null;
  spent_by: string | null;
}

export async function getRecentTransactions(limit = 8): Promise<Transaction[]> {
  const supabase = await createClient();
  const [categories, members] = await Promise.all([getCategories(supabase), getMembers(supabase)]);

  const { data, error } = await supabase
    .from('transactions')
    .select('id, kind, amount_cents, occurred_on, description, category_id, spent_by')
    .order('occurred_on', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw new Error(`Falha ao carregar gastos: ${error.message}`);

  return ((data ?? []) as TransactionRow[]).map((row) => ({
    id: row.id,
    kind: row.kind,
    amountCents: row.amount_cents,
    occurredOn: row.occurred_on,
    description: row.description,
    category: row.category_id ? (categories.get(row.category_id) ?? null) : null,
    spentBy: row.spent_by ? (members.get(row.spent_by) ?? null) : null,
  }));
}

export async function getMonthSummary(
  today: IsoDate,
  budgetCents: number | null,
): Promise<MonthSummary> {
  const supabase = await createClient();
  const { start, end } = monthRange(today);

  const [expenses, occurrences] = await Promise.all([
    supabase
      .from('transactions')
      .select('amount_cents')
      .eq('kind', 'expense')
      .gte('occurred_on', start)
      .lte('occurred_on', end),
    supabase
      .from('bill_occurrences')
      .select('amount_cents, status')
      .gte('due_date', start)
      .lte('due_date', end),
  ]);

  if (expenses.error) throw new Error(`Falha ao somar gastos: ${expenses.error.message}`);
  if (occurrences.error) throw new Error(`Falha ao somar contas: ${occurrences.error.message}`);

  const spentCents = sumCents((expenses.data ?? []).map((r) => r.amount_cents as number));

  const rows = (occurrences.data ?? []) as Array<{ amount_cents: number; status: OccurrenceStatus }>;
  const duePendingCents = sumCents(rows.filter((r) => r.status === 'pending').map((r) => r.amount_cents));
  const duePaidCents = sumCents(rows.filter((r) => r.status === 'paid').map((r) => r.amount_cents));

  return {
    month: start,
    spentCents,
    duePendingCents,
    duePaidCents,
    budgetCents,
    // Sem orçamento definido não existe "sobra". Null aqui obriga a UI a tratar
    // o caso em vez de exibir um número que não significa nada.
    remainingCents: budgetCents === null ? null : budgetCents - spentCents - duePendingCents,
  };
}

interface TaskRow {
  id: string;
  title: string;
  description: string | null;
  due_date: string | null;
  status: TaskStatus;
  assignee_id: string | null;
  bill_id: string | null;
}

/**
 * Tarefas em aberto. Só as abertas: uma lista que acumula tudo o que já foi
 * feito deixa de ser algo que se olha.
 */
export async function getOpenTasks(limit = 6): Promise<Task[]> {
  const supabase = await createClient();
  const members = await getMembers(supabase);

  const { data, error } = await supabase
    .from('tasks')
    .select('id, title, description, due_date, status, assignee_id, bill_id')
    .in('status', ['todo', 'doing'])
    // Nulls por último: sem prazo não é urgente, mas continua na lista.
    .order('due_date', { ascending: true, nullsFirst: false })
    .limit(limit);

  if (error) throw new Error(`Falha ao carregar tarefas: ${error.message}`);

  return ((data ?? []) as TaskRow[]).map((row) => ({
    id: row.id,
    title: row.title,
    description: row.description,
    dueDate: row.due_date,
    status: row.status,
    assignee: row.assignee_id ? (members.get(row.assignee_id) ?? null) : null,
    billId: row.bill_id,
  }));
}
