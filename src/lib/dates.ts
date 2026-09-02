import { addDays, differenceInCalendarDays, format, lastDayOfMonth, parseISO, subMonths } from 'date-fns';
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';

/**
 * Datas de negócio são strings 'YYYY-MM-DD' — dia civil, sem hora, sem fuso.
 *
 * O fuso importa em exatamente um ponto: descobrir que dia é "hoje" para a
 * família. Uma conta que vence dia 15 vence dia 15 em São Paulo, não às 21h do
 * dia 14 em UTC. Todo cálculo de vencimento e atraso parte de `todayInTz`.
 */

/** Data civil no formato 'YYYY-MM-DD'. */
export type IsoDate = string;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(value: string): value is IsoDate {
  return ISO_DATE.test(value) && !Number.isNaN(parseISO(value).getTime());
}

export function assertIsoDate(value: string): IsoDate {
  if (!isIsoDate(value)) {
    throw new RangeError(`Data inválida (esperado YYYY-MM-DD): ${JSON.stringify(value)}`);
  }
  return value;
}

/** Que dia é hoje para esta família. Nunca usar `new Date()` cru para isso. */
export function todayInTz(timezone: string, now: Date = new Date()): IsoDate {
  return formatInTimeZone(now, timezone, 'yyyy-MM-dd');
}

/**
 * Dias civis entre hoje e o vencimento. Positivo = falta; negativo = atrasada.
 * Comparação de dia civil, não de instante — não há erro de fuso aqui.
 */
export function daysUntil(dueDate: IsoDate, today: IsoDate): number {
  return differenceInCalendarDays(parseISO(assertIsoDate(dueDate)), parseISO(assertIsoDate(today)));
}

/**
 * Atraso é DERIVADO, nunca armazenado. Guardar 'overdue' como estado no banco
 * cria drift: a linha continua dizendo 'pending' até alguém rodar um job.
 */
export function isOverdue(dueDate: IsoDate, today: IsoDate, status: string): boolean {
  return status === 'pending' && daysUntil(dueDate, today) < 0;
}

/** Rótulo humano do vencimento. Cor sozinha nunca carrega esta informação. */
export function dueLabel(dueDate: IsoDate, today: IsoDate): string {
  const days = daysUntil(dueDate, today);
  if (days === 0) return 'vence hoje';
  if (days === 1) return 'vence amanhã';
  if (days > 1) return `vence em ${days} dias`;
  if (days === -1) return 'vencida ontem';
  return `vencida há ${Math.abs(days)} dias`;
}

export interface DateRange {
  start: IsoDate;
  end: IsoDate;
}

/**
 * Primeiro e último dia do mês que contém `reference`.
 *
 * `parseISO` devolve meia-noite LOCAL, então toda formatação aqui também é
 * local (`format`, não `formatInTimeZone(..., 'UTC')`). Misturar os dois
 * desloca a data em um dia em fusos de offset positivo — passaria no teste
 * rodando no Brasil e quebraria na Vercel.
 */
export function monthRange(reference: IsoDate): DateRange {
  const ref = parseISO(assertIsoDate(reference));
  return {
    start: format(ref, 'yyyy-MM-01'),
    end: format(lastDayOfMonth(ref), 'yyyy-MM-dd'),
  };
}

/**
 * Os N meses civis anteriores ao mês de `reference`, sem incluí-lo.
 * É a linha de base do Insights: comparar setembro com "a média dos últimos 3
 * meses" significa jun-ago, não jul-set.
 */
export function previousMonthsRange(reference: IsoDate, months: number): DateRange {
  if (!Number.isInteger(months) || months < 1) {
    throw new RangeError(`months deve ser inteiro >= 1, recebido ${months}`);
  }
  const ref = parseISO(assertIsoDate(reference));
  const firstOfCurrent = parseISO(format(ref, 'yyyy-MM-01'));
  return {
    start: format(subMonths(firstOfCurrent, months), 'yyyy-MM-dd'),
    end: format(addDays(firstOfCurrent, -1), 'yyyy-MM-dd'),
  };
}

const MONTHS_PT = [
  'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
  'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro',
] as const;

export function monthLabel(reference: IsoDate): string {
  const month = Number(assertIsoDate(reference).slice(5, 7));
  return MONTHS_PT[month - 1]!;
}

/** 'YYYY-MM-DD' → '15/09'. Para listas densas onde o ano é ruído. */
export function shortDate(date: IsoDate): string {
  const iso = assertIsoDate(date);
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
}

/** 'hoje' / 'ontem' / '28/08' — usado na lista de últimos gastos. */
export function relativeDayLabel(date: IsoDate, today: IsoDate): string {
  const diff = daysUntil(date, today);
  if (diff === 0) return 'hoje';
  if (diff === -1) return 'ontem';
  if (diff === -2) return 'anteontem';
  return shortDate(date);
}

/**
 * Instante UTC do início do dia civil no fuso da família.
 * Usado para filtrar colunas `timestamptz` por dia de negócio.
 *
 * `fromZonedTime` (hora local no fuso → instante), não `toZonedTime`, que faz
 * o caminho inverso e daria um resultado deslocado pelo offset.
 */
export function startOfDayUtc(date: IsoDate, timezone: string): Date {
  return fromZonedTime(`${assertIsoDate(date)}T00:00:00`, timezone);
}
