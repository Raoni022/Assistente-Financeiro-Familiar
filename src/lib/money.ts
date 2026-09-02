/**
 * Dinheiro é SEMPRE bigint/number inteiro em centavos.
 *
 * Este módulo é client-safe: a formatação roda na UI, a análise roda no agente
 * de Gastos. Nenhuma aritmética monetária deve acontecer fora daqui em float.
 */

/** Marca nominal para não confundir centavos com reais em assinatura de função. */
export type Cents = number;

const BRL = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const BRL_COMPACT = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

export function formatCents(cents: Cents): string {
  return BRL.format(cents / 100);
}

/** "R$ 1.204" — para onde o centavo é ruído (cards de resumo, eixos). */
export function formatCentsCompact(cents: Cents): string {
  return BRL_COMPACT.format(Math.round(cents / 100));
}

export function centsFromReais(reais: number): Cents {
  return Math.round(reais * 100);
}

export class MoneyParseError extends Error {
  constructor(public override readonly message: string) {
    super(message);
    this.name = 'MoneyParseError';
  }
}

/**
 * Converte uma expressão monetária em pt-BR para centavos.
 *
 * Regras de separador — pt-BR usa "." para milhar e "," para decimal, mas gente
 * digitando rápido mistura os dois hábitos. A desambiguação é explícita:
 *
 *   "1.234,56" → ambos presentes: "." é milhar, "," é decimal        → 123456
 *   "1234,5"   → só vírgula: sempre decimal                          →  123450
 *   "1.234"    → só ponto, exatamente 3 dígitos depois: milhar       →  123400
 *   "80.50"    → só ponto, 1-2 dígitos depois: decimal (hábito en-US) →   8050
 *
 * Não interpreta número por extenso ("mil e duzentos") — isso fica a cargo do
 * LLM de extração, que devolve um valor numérico para esta função validar.
 */
export function parseBRLToCents(input: string): Cents {
  const cleaned = input
    .toLowerCase()
    .replace(/r\$/g, '')
    .replace(/reais|real|conto|pila|pau/g, '')
    .trim();

  const match = /(-?)(\d[\d.,]*)/.exec(cleaned);
  if (!match) {
    throw new MoneyParseError(`Nenhum valor numérico em ${JSON.stringify(input)}`);
  }

  const negative = match[1] === '-';
  const raw = match[2]!;

  const lastComma = raw.lastIndexOf(',');
  const lastDot = raw.lastIndexOf('.');

  let normalized: string;
  if (lastComma !== -1 && lastDot !== -1) {
    // Ambos: o que aparece por último é o decimal.
    normalized =
      lastComma > lastDot
        ? raw.replace(/\./g, '').replace(',', '.')
        : raw.replace(/,/g, '');
  } else if (lastComma !== -1) {
    normalized = raw.replace(/\./g, '').replace(',', '.');
  } else if (lastDot !== -1) {
    const decimals = raw.length - lastDot - 1;
    // 3 dígitos depois do último ponto e nenhum outro sinal → milhar.
    normalized = decimals === 3 ? raw.replace(/\./g, '') : raw;
  } else {
    normalized = raw;
  }

  const value = Number(normalized);
  if (!Number.isFinite(value)) {
    throw new MoneyParseError(`Valor não numérico após normalizar: ${normalized}`);
  }

  const cents = Math.round(value * 100);
  if (!Number.isSafeInteger(cents)) {
    throw new MoneyParseError(`Valor fora da faixa segura: ${normalized}`);
  }

  return negative ? -cents : cents;
}

/** Soma segura: entrada já é inteira, mas protege contra float infiltrado. */
export function sumCents(values: readonly Cents[]): Cents {
  let total = 0;
  for (const v of values) {
    if (!Number.isInteger(v)) {
      throw new MoneyParseError(`Centavos não inteiros na soma: ${v}`);
    }
    total += v;
  }
  return total;
}

/**
 * Variação percentual entre dois valores. Retorna null quando a base é zero —
 * "aumentou infinito%" não é um insight, é um bug. O Agente de Insights precisa
 * tratar esse null explicitamente em vez de exibir Infinity.
 */
export function percentChange(currentCents: Cents, baselineCents: Cents): number | null {
  if (baselineCents === 0) return null;
  return ((currentCents - baselineCents) / Math.abs(baselineCents)) * 100;
}
