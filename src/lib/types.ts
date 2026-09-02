import type { Cents } from '@/lib/money';
import type { IsoDate } from '@/lib/dates';

/**
 * Tipos de domínio, client-safe. São o contrato entre a camada de queries
 * (src/server/db/queries) e a UI.
 *
 * Não são gerados de `supabase gen types`: aquilo devolve o formato cru das
 * tabelas, com nulls por toda parte e nomes em snake_case. Estes já são o
 * formato que a UI consome. A conversão acontece em exatamente uma camada —
 * as funções de query — o que a torna revisável.
 */

export type HouseholdRole = 'admin' | 'member';

export interface Household {
  id: string;
  name: string;
  timezone: string;
  monthlyBudgetCents: Cents | null;
}

export interface Member {
  id: string;
  displayName: string;
  role: HouseholdRole;
}

export interface Category {
  id: string;
  key: string;
  label: string;
  isBill: boolean;
}

export type OccurrenceStatus = 'pending' | 'paid' | 'cancelled';

/** Uma ocorrência de conta já enriquecida com o que a UI precisa mostrar. */
export interface BillOccurrence {
  id: string;
  billId: string;
  title: string;
  amountCents: Cents;
  dueDate: IsoDate;
  status: OccurrenceStatus;
  category: Category | null;
  responsible: Member | null;
  /** Derivado de dueDate + status. Nunca lido do banco. */
  isOverdue: boolean;
  /** Negativo = atrasada. */
  daysUntilDue: number;
}

export type TransactionKind = 'expense' | 'income';

export interface Transaction {
  id: string;
  kind: TransactionKind;
  amountCents: Cents;
  occurredOn: IsoDate;
  description: string | null;
  category: Category | null;
  spentBy: Member | null;
}

export type TaskStatus = 'todo' | 'doing' | 'done' | 'cancelled';

export interface Task {
  id: string;
  title: string;
  description: string | null;
  dueDate: IsoDate | null;
  status: TaskStatus;
  assignee: Member | null;
  billId: string | null;
}

/** Resumo do mês exibido no card herói. */
export interface MonthSummary {
  /** Mês de referência, primeiro dia. */
  month: IsoDate;
  /** Gastos já registrados no mês. */
  spentCents: Cents;
  /** Contas do mês ainda pendentes. */
  duePendingCents: Cents;
  /** Contas do mês já pagas. */
  duePaidCents: Cents;
  /** Orçamento previsto do household. Null = não definido. */
  budgetCents: Cents | null;
  /**
   * Quanto sobra do orçamento depois do que já saiu e do que ainda vai sair.
   * Null quando não há orçamento definido — sem base, não há "sobra".
   */
  remainingCents: Cents | null;
}
