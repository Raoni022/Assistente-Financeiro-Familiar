import {
  addMonths,
  addWeeks,
  format,
  getDaysInMonth,
  parseISO,
  setDate,
} from 'date-fns';
import { assertIsoDate, daysUntil, type IsoDate } from '@/lib/dates';
import type { Cents } from '@/lib/money';

/**
 * Lógica de negócio do Agente de Contas.
 *
 * Nada aqui chama LLM nem banco. "Quando esta conta vence?" e "isto parece
 * duplicado?" são perguntas determinísticas — passar isso por um modelo seria
 * pagar para tornar não-determinístico algo que já tem resposta certa.
 */

export type Recurrence = 'none' | 'weekly' | 'monthly' | 'quarterly' | 'yearly';

export interface RecurrenceSpec {
  recurrence: Recurrence;
  startsOn: IsoDate;
  /** Null = sem fim previsto. */
  endsOn: IsoDate | null;
  /** Dia do mês (1–31) para mensal/trimestral/anual. */
  recurrenceDay: number | null;
}

/** Teto de segurança: um range absurdo não deve gerar milhares de linhas. */
const MAX_OCCURRENCES = 260;

const MONTH_STEP: Record<Extract<Recurrence, 'monthly' | 'quarterly' | 'yearly'>, number> = {
  monthly: 1,
  quarterly: 3,
  yearly: 12,
};

/**
 * Datas de vencimento de uma conta dentro de uma janela.
 *
 * O caso que importa é dia 31: uma conta que vence "todo dia 31" vence em 28 (ou
 * 29) de fevereiro, não é pulada nem escorrega para 1º de março. É assim que
 * banco e cartão se comportam, e é o comportamento que o usuário espera ver.
 */
export function generateOccurrenceDates(
  spec: RecurrenceSpec,
  rangeStart: IsoDate,
  rangeEnd: IsoDate,
): IsoDate[] {
  const startsOn = assertIsoDate(spec.startsOn);
  const from = assertIsoDate(rangeStart);
  const to = assertIsoDate(rangeEnd);

  if (to < from) return [];

  const hardEnd = spec.endsOn ? minIso(assertIsoDate(spec.endsOn), to) : to;
  if (hardEnd < startsOn) return [];

  const inWindow = (date: IsoDate) => date >= startsOn && date >= from && date <= hardEnd;

  if (spec.recurrence === 'none') {
    return inWindow(startsOn) ? [startsOn] : [];
  }

  const dates: IsoDate[] = [];

  if (spec.recurrence === 'weekly') {
    let cursor = parseISO(startsOn);
    while (dates.length < MAX_OCCURRENCES) {
      const date = format(cursor, 'yyyy-MM-dd');
      if (date > hardEnd) break;
      if (inWindow(date)) dates.push(date);
      cursor = addWeeks(cursor, 1);
    }
    return dates;
  }

  if (spec.recurrenceDay === null) {
    throw new RangeError(`Recorrência ${spec.recurrence} exige recurrenceDay.`);
  }
  if (!Number.isInteger(spec.recurrenceDay) || spec.recurrenceDay < 1 || spec.recurrenceDay > 31) {
    throw new RangeError(`recurrenceDay fora de 1..31: ${spec.recurrenceDay}`);
  }

  const step = MONTH_STEP[spec.recurrence];
  // O cursor é sempre o dia 1: assim `addMonths` é exato e o ajuste de dia curto
  // acontece num só lugar, explícito, em vez de depender do clamp implícito da
  // biblioteca sobre uma data que já é dia 31.
  let cursor = parseISO(format(parseISO(startsOn), 'yyyy-MM-01'));

  while (dates.length < MAX_OCCURRENCES) {
    const day = Math.min(spec.recurrenceDay, getDaysInMonth(cursor));
    const date = format(setDate(cursor, day), 'yyyy-MM-dd');

    if (date > hardEnd) break;
    if (inWindow(date)) dates.push(date);

    cursor = addMonths(cursor, step);
  }

  return dates;
}

function minIso(a: IsoDate, b: IsoDate): IsoDate {
  return a < b ? a : b;
}

// ---------------------------------------------------------------------------
// Detecção de duplicata
// ---------------------------------------------------------------------------

export interface BillFingerprint {
  id: string;
  title: string;
  amountCents: Cents;
  dueDate: IsoDate;
}

export type DuplicateReason =
  | 'titulo_e_valor_iguais'
  | 'titulo_parecido_mesma_data'
  | 'valor_e_data_iguais';

export interface DuplicateCandidate {
  billId: string;
  reason: DuplicateReason;
  /** 0..1. Acima de 0.9 o agente pergunta antes de criar. */
  confidence: number;
}

/**
 * Normaliza para comparação: sem acento, sem pontuação, minúsculo.
 * "Conta de Luz — CEMIG" e "conta de luz cemig" viram a mesma coisa.
 */
export function normalizeTitle(title: string): string {
  return title
    .normalize('NFD')
    // Remove os diacríticos que o NFD separou (U+0300–U+036F).
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Palavras que não distinguem uma conta de outra. */
const STOPWORDS = new Set(['de', 'da', 'do', 'a', 'o', 'e', 'em', 'para', 'conta', 'fatura']);

function tokens(title: string): Set<string> {
  return new Set(
    normalizeTitle(title)
      .split(' ')
      .filter((word) => word.length > 0 && !STOPWORDS.has(word)),
  );
}

/** Jaccard sobre tokens significativos. 1 = mesmos termos, 0 = nada em comum. */
export function titleSimilarity(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 && tb.size === 0) return 1;
  if (ta.size === 0 || tb.size === 0) return 0;

  let shared = 0;
  for (const token of ta) if (tb.has(token)) shared += 1;

  return shared / (ta.size + tb.size - shared);
}

/**
 * Contas existentes que parecem ser a mesma coisa que `candidate`.
 *
 * Isto NÃO bloqueia a criação — devolve suspeita para o agente perguntar. Um
 * falso positivo que vira pergunta custa uma frase; um falso negativo vira uma
 * conta paga duas vezes.
 */
export function findPotentialDuplicates(
  candidate: Omit<BillFingerprint, 'id'>,
  existing: readonly BillFingerprint[],
): DuplicateCandidate[] {
  const found: DuplicateCandidate[] = [];

  for (const bill of existing) {
    const similarity = titleSimilarity(candidate.title, bill.title);
    const sameAmount = candidate.amountCents === bill.amountCents;
    const dayGap = Math.abs(daysUntil(bill.dueDate, candidate.dueDate));

    if (similarity >= 0.8 && sameAmount && dayGap <= 5) {
      found.push({ billId: bill.id, reason: 'titulo_e_valor_iguais', confidence: 0.95 });
    } else if (similarity >= 0.8 && dayGap <= 3) {
      found.push({ billId: bill.id, reason: 'titulo_parecido_mesma_data', confidence: 0.75 });
    } else if (sameAmount && dayGap === 0 && similarity >= 0.34) {
      found.push({ billId: bill.id, reason: 'valor_e_data_iguais', confidence: 0.7 });
    }
  }

  return found.sort((a, b) => b.confidence - a.confidence);
}

// ---------------------------------------------------------------------------
// Ordenação para exibição
// ---------------------------------------------------------------------------

export interface SortableOccurrence {
  dueDate: IsoDate;
  status: string;
  amountCents: Cents;
}

/**
 * Ordem de atenção: vencidas primeiro (mais antiga na frente, porque é a que
 * está acumulando juros há mais tempo), depois as futuras por proximidade.
 * Empate no dia, o valor maior vem antes.
 */
export function sortByAttention<T extends SortableOccurrence>(
  occurrences: readonly T[],
  today: IsoDate,
): T[] {
  return [...occurrences].sort((a, b) => {
    const aOverdue = a.status === 'pending' && a.dueDate < today;
    const bOverdue = b.status === 'pending' && b.dueDate < today;

    if (aOverdue !== bOverdue) return aOverdue ? -1 : 1;
    if (a.dueDate !== b.dueDate) return a.dueDate < b.dueDate ? -1 : 1;
    return b.amountCents - a.amountCents;
  });
}
