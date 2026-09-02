import {
  addDays,
  addMonths,
  format,
  lastDayOfMonth,
  nextFriday,
  nextMonday,
  nextSaturday,
  nextSunday,
  nextThursday,
  nextTuesday,
  nextWednesday,
  parseISO,
} from 'date-fns';
import { assertIsoDate, daysUntil, isIsoDate, type IsoDate } from '@/lib/dates';

/**
 * Lógica do Agente de Tarefas.
 *
 * Espelho da Fase 3, com o sinal invertido: gasto olha para trás, tarefa olha
 * para frente. Isso muda **todas** as regras, não só a direção da soma:
 *
 *  - "dia 15" num gasto é do mês passado; numa tarefa é deste mês ou do próximo
 *  - "sexta" num gasto é a anterior; numa tarefa é a próxima
 *  - gasto sem data mencionada é hoje; tarefa sem data mencionada **não tem
 *    prazo** — e isso é legítimo, não uma falta de informação
 *
 * Reaproveitar `resolveDateExpression` do Agente de Gastos aqui daria uma data
 * no passado para todo prazo. São funções diferentes de propósito.
 */

type NextWeekday = (date: Date) => Date;

const WEEKDAYS: Record<string, { index: number; next: NextWeekday }> = {
  domingo: { index: 0, next: nextSunday },
  segunda: { index: 1, next: nextMonday },
  terca: { index: 2, next: nextTuesday },
  quarta: { index: 3, next: nextWednesday },
  quinta: { index: 4, next: nextThursday },
  sexta: { index: 5, next: nextFriday },
  sabado: { index: 6, next: nextSaturday },
};

function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s/-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Resolve um prazo dito em linguagem natural.
 *
 * Três retornos distintos, e a diferença importa:
 *  - `undefined` → não foi mencionado prazo. Tarefa sem prazo é válida.
 *  - `null`      → mencionou algo que não entendi. O agente pergunta.
 *  - `IsoDate`   → prazo resolvido.
 */
export function resolveDeadline(
  expression: string | null,
  today: IsoDate,
): IsoDate | null | undefined {
  const reference = parseISO(assertIsoDate(today));

  if (expression === null || expression.trim() === '') return undefined;

  const text = normalize(expression);
  const iso = (date: Date) => format(date, 'yyyy-MM-dd');

  const asIso = isIsoDate(text) ? text : null;
  if (asIso !== null) return asIso;

  const numeric = /^(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?$/.exec(text);
  if (numeric) {
    const day = Number(numeric[1]);
    const month = Number(numeric[2]);
    const yearRaw = numeric[3];
    const year = yearRaw
      ? Number(yearRaw.length === 2 ? `20${yearRaw}` : yearRaw)
      : reference.getFullYear();

    const candidate = buildDate(year, month, day);
    if (!candidate) return null;

    // Sem ano informado e a data já passou: prazo aponta para frente, então
    // "15/01" dito em setembro é de janeiro do ano que vem.
    if (!yearRaw && candidate < iso(reference)) {
      return buildDate(year + 1, month, day);
    }
    return candidate;
  }

  if (/\bhoje\b/.test(text)) return today;
  if (/\bdepois de amanha\b/.test(text)) return iso(addDays(reference, 2));
  if (/\bamanha\b/.test(text)) return iso(addDays(reference, 1));
  if (/\bsemana que vem\b|\bproxima semana\b/.test(text)) return iso(addDays(reference, 7));
  if (/\bmes que vem\b|\bproximo mes\b/.test(text)) return iso(addMonths(reference, 1));
  if (/\bfim do mes\b|\bfinal do mes\b/.test(text)) return iso(lastDayOfMonth(reference));

  const inDays = /\bem (\d{1,3}) dias?\b/.exec(text);
  if (inDays) {
    const days = Number(inDays[1]);
    if (days > 365) return null;
    return iso(addDays(reference, days));
  }

  const inWeeks = /\bem (\d{1,2}) semanas?\b/.exec(text);
  if (inWeeks) return iso(addDays(reference, Number(inWeeks[1]) * 7));

  const dayOfMonth = /\bdia (\d{1,2})\b/.exec(text);
  if (dayOfMonth) {
    const day = Number(dayOfMonth[1]);
    if (day < 1 || day > 31) return null;

    const thisMonth = buildDate(reference.getFullYear(), reference.getMonth() + 1, day);
    // "dia 15" dito no dia 20 é do mês que vem, não de cinco dias atrás.
    if (thisMonth && thisMonth >= iso(reference)) return thisMonth;

    const next = addMonths(reference, 1);
    return buildDate(next.getFullYear(), next.getMonth() + 1, day);
  }

  for (const [name, weekday] of Object.entries(WEEKDAYS)) {
    if (!new RegExp(`\\b${name}\\b`).test(text)) continue;

    // "sexta" numa sexta é hoje; "sexta que vem" é a próxima, sempre.
    const explicitlyNext = /\bque vem\b|\bproxim[ao]\b/.test(text);
    if (!explicitlyNext && reference.getDay() === weekday.index) return today;

    return iso(weekday.next(reference));
  }

  return null;
}

function buildDate(year: number, month: number, day: number): IsoDate | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const iso = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return isIsoDate(iso) ? iso : null;
}

// ---------------------------------------------------------------------------
// Estado e ordenação
// ---------------------------------------------------------------------------

export type TaskStatus = 'todo' | 'doing' | 'done' | 'cancelled';

/**
 * Transições permitidas. Uma tarefa cancelada ou concluída pode ser reaberta —
 * gente muda de ideia — mas não se "conclui" algo que já foi cancelado sem
 * passar por reabrir, senão o histórico mente sobre o que aconteceu.
 */
const ALLOWED_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  todo: ['doing', 'done', 'cancelled'],
  doing: ['todo', 'done', 'cancelled'],
  done: ['todo', 'doing'],
  cancelled: ['todo'],
};

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  if (from === to) return false;
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export interface SortableTask {
  dueDate: IsoDate | null;
  status: TaskStatus;
}

/**
 * Ordem de atenção. Sem prazo não significa sem importância, mas significa sem
 * urgência: vai depois de tudo que tem data, e antes do que já foi resolvido.
 */
export function sortTasksByUrgency<T extends SortableTask>(tasks: readonly T[], today: IsoDate): T[] {
  const rank = (task: T): number => {
    if (task.status === 'done' || task.status === 'cancelled') return 3;
    if (task.dueDate === null) return 2;
    return daysUntil(task.dueDate, today) < 0 ? 0 : 1;
  };

  return [...tasks].sort((a, b) => {
    const rankDiff = rank(a) - rank(b);
    if (rankDiff !== 0) return rankDiff;

    if (a.dueDate === null && b.dueDate === null) return 0;
    if (a.dueDate === null) return 1;
    if (b.dueDate === null) return -1;
    return a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0;
  });
}
