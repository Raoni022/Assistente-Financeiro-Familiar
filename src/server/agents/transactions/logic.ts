import {
  format,
  parseISO,
  previousFriday,
  previousMonday,
  previousSaturday,
  previousSunday,
  previousThursday,
  previousTuesday,
  previousWednesday,
  subDays,
  subMonths,
} from 'date-fns';
import { assertIsoDate, isIsoDate, type IsoDate } from '@/lib/dates';

/**
 * Lógica de extração do Agente de Gastos.
 *
 * Mesma divisão de trabalho do valor monetário: o modelo **recorta** a expressão
 * de tempo que a pessoa usou ("ontem", "sexta passada", "dia 28") e o código
 * resolve para uma data. Pedir a data já calculada ao LLM é pedir aritmética de
 * calendário — a operação em que ele mais erra e a que mais barato sai testar.
 */

type PreviousWeekday = (date: Date) => Date;

const WEEKDAYS: Record<string, { index: number; previous: PreviousWeekday }> = {
  domingo: { index: 0, previous: previousSunday },
  segunda: { index: 1, previous: previousMonday },
  terca: { index: 2, previous: previousTuesday },
  quarta: { index: 3, previous: previousWednesday },
  quinta: { index: 4, previous: previousThursday },
  sexta: { index: 5, previous: previousFriday },
  sabado: { index: 6, previous: previousSaturday },
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
 * Resolve a expressão de tempo dita pelo usuário para uma data civil.
 *
 * `null` significa "não entendi" — e o agente pergunta, em vez de assumir hoje.
 * Assumir hoje num gasto que era de outro mês corrompe silenciosamente a
 * consolidação do período, que é justamente o que o Insights vai ler depois.
 *
 * Expressão vazia é caso diferente: quem diz "gastei 80 no mercado" sem falar de
 * tempo está falando de hoje, e isso é seguro assumir.
 */
export function resolveDateExpression(expression: string | null, today: IsoDate): IsoDate | null {
  const reference = parseISO(assertIsoDate(today));

  if (expression === null || expression.trim() === '') return today;

  const text = normalize(expression);
  const iso = (date: Date) => format(date, 'yyyy-MM-dd');

  /*
   * Não usar `isIsoDate(text)` como guarda direto aqui: ele é um type predicate
   * para `IsoDate`, que é alias de `string`, então o ramo seguinte estreitaria
   * `text` para `never` e todo uso posterior viraria erro de tipo.
   */
  const asIso = isIsoDate(text) ? text : null;
  if (asIso !== null) return asIso;

  // 28/08 ou 28/08/2026 ou 28-8
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

    // Sem ano informado e a data cairia no futuro: quem fala de um gasto está
    // falando do passado, então 28/12 dito em janeiro é do ano anterior.
    if (!yearRaw && candidate > iso(reference)) {
      const previousYear = buildDate(year - 1, month, day);
      return previousYear ?? null;
    }
    return candidate;
  }

  if (/\bhoje\b|\bagora\b|\bhoje de manha\b/.test(text)) return today;
  if (/\banteontem\b/.test(text)) return iso(subDays(reference, 2));
  if (/\bontem\b/.test(text)) return iso(subDays(reference, 1));
  if (/\bsemana passada\b|\bsemana retrasada\b/.test(text)) {
    return iso(subDays(reference, text.includes('retrasada') ? 14 : 7));
  }
  if (/\bmes passado\b/.test(text)) return iso(subMonths(reference, 1));

  // "dia 28", "no dia 3"
  const dayOfMonth = /\bdia (\d{1,2})\b/.exec(text);
  if (dayOfMonth) {
    const day = Number(dayOfMonth[1]);
    if (day < 1 || day > 31) return null;

    const currentMonth = buildDate(reference.getFullYear(), reference.getMonth() + 1, day);
    // "dia 28" dito no dia 3 é do mês passado, não daqui a 25 dias.
    if (currentMonth && currentMonth <= iso(reference)) return currentMonth;

    const previous = subMonths(reference, 1);
    return buildDate(previous.getFullYear(), previous.getMonth() + 1, day);
  }

  for (const [name, weekday] of Object.entries(WEEKDAYS)) {
    if (!new RegExp(`\\b${name}\\b`).test(text)) continue;

    const explicitlyPast = /\bpassad[ao]\b|\bultim[ao]\b|\bretrasad[ao]\b/.test(text);

    // "na sexta" num dia que É sexta significa hoje; "sexta passada" significa
    // a anterior. A diferença é exatamente a palavra "passada".
    if (!explicitlyPast && reference.getDay() === weekday.index) return today;

    const previous = weekday.previous(reference);
    return iso(text.includes('retrasad') ? subDays(previous, 7) : previous);
  }

  return null;
}

function buildDate(year: number, month: number, day: number): IsoDate | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const iso = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  // Rejeita 31 de fevereiro em vez de deixar a data escorregar para março.
  return isIsoDate(iso) ? iso : null;
}

// ---------------------------------------------------------------------------
// Categoria
// ---------------------------------------------------------------------------

/**
 * Palavras que indicam categoria sem margem para dúvida.
 *
 * Isto NÃO substitui o modelo: serve como rede quando ele devolve uma categoria
 * que não existe, ou nenhuma. Marcas e apps são o caso em que a heurística ganha
 * do modelo com folga — "ifood" é delivery em 100% das vezes.
 */
const CATEGORY_HINTS: Array<[category: string, patterns: RegExp]> = [
  ['delivery', /\bifood\b|\brappi\b|\bdelivery\b|\bpedi comida\b|\bpedimos comida\b/],
  ['transporte', /\buber\b|\b99\b|\btaxi\b|\bonibus\b|\bmetro\b|\bpassagem\b|\bestacionamento\b/],
  ['combustivel', /\bgasolina\b|\betanol\b|\balcool\b|\bdiesel\b|\bposto\b|\babasteci\w*/],
  ['mercado', /\bmercado\b|\bsupermercado\b|\bfeira\b|\bhortifruti\b|\batacad\w*/],
  ['farmacia', /\bfarmacia\b|\bdrogaria\b|\bremedio\b/],
  ['restaurante', /\brestaurante\b|\balmoc\w*|\bjant\w*|\blanche\b|\bpadaria\b|\bcafe\b|\bbar\b/],
  ['saude', /\bmedico\b|\bdentista\b|\bconsulta\b|\bexame\b|\bterapia\b|\bpsicolog\w*/],
  ['pet', /\bpet\b|\bracao\b|\bveterinar\w*|\bpetshop\b/],
  ['lazer', /\bcinema\b|\bshow\b|\bteatro\b|\bviagem\b|\bpasseio\b|\bingresso\b/],
  ['vestuario', /\broupa\b|\bcalcado\b|\btenis\b|\bsapato\b|\bcamisa\b/],
  ['assinatura', /\bnetflix\b|\bspotify\b|\bassinatura\b|\bstreaming\b|\bdisney\b/],
  ['educacao', /\bcurso\b|\bescola\b|\bfaculdade\b|\blivro\b|\bmaterial escolar\b/],
  ['casa', /\bmoveis\b|\bdecoracao\b|\breforma\b|\bferramenta\b|\bfaxina\b/],
];

/**
 * Categoria inferida do texto cru, ou null quando nada é evidente.
 *
 * Null é resposta legítima: chutar "outros" esconde do usuário que a
 * classificação não aconteceu, e uma categoria errada envenena o Insights.
 */
export function inferCategory(text: string): string | null {
  const normalized = normalize(text);
  for (const [category, pattern] of CATEGORY_HINTS) {
    if (pattern.test(normalized)) return category;
  }
  return null;
}

/**
 * Concilia a categoria do modelo com a heurística.
 *
 * O modelo ganha quando devolve algo válido — ele lê contexto que palavra-chave
 * nenhuma pega ("comprei fralda", "paguei o mecânico"). A heurística entra
 * quando ele erra o vocabulário ou não responde.
 */
export function reconcileCategory(
  fromModel: string | null,
  rawText: string,
  allowedKeys: readonly string[],
): { key: string | null; source: 'model' | 'heuristic' | 'none' } {
  if (fromModel && allowedKeys.includes(fromModel)) {
    return { key: fromModel, source: 'model' };
  }

  const inferred = inferCategory(rawText);
  if (inferred && allowedKeys.includes(inferred)) {
    return { key: inferred, source: 'heuristic' };
  }

  return { key: null, source: 'none' };
}

// ---------------------------------------------------------------------------
// Consolidação
// ---------------------------------------------------------------------------

export interface AggregatableTransaction {
  amountCents: number;
  categoryKey: string | null;
  spentById: string | null;
}

export interface AggregateBucket {
  key: string;
  totalCents: number;
  count: number;
}

/**
 * Soma por chave, do maior para o menor. Aritmética inteira do começo ao fim —
 * nenhum ponto flutuante toca em dinheiro.
 */
export function aggregateBy(
  transactions: readonly AggregatableTransaction[],
  dimension: 'category' | 'person',
): AggregateBucket[] {
  const totals = new Map<string, AggregateBucket>();

  for (const transaction of transactions) {
    const key =
      (dimension === 'category' ? transaction.categoryKey : transaction.spentById) ?? 'sem_categoria';

    const bucket = totals.get(key) ?? { key, totalCents: 0, count: 0 };
    bucket.totalCents += transaction.amountCents;
    bucket.count += 1;
    totals.set(key, bucket);
  }

  return [...totals.values()].sort((a, b) => b.totalCents - a.totalCents);
}
