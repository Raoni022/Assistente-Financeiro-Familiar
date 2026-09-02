import { z } from 'zod';
import { isIsoDate } from '@/lib/dates';

/**
 * Payload por intenção do Agente de Gastos.
 *
 * Duas decisões que se repetem do Agente de Contas, pelo mesmo motivo: o modelo
 * **recorta**, o código **converte**.
 *
 *  - `amount` é o texto cru ("80", "R$ 1.204,00", "40 conto") → parseBRLToCents
 *  - `dateExpression` é a expressão de tempo literal ("ontem", "sexta passada",
 *    "dia 28") → resolveDateExpression
 *
 * Pedir `occurredOn` já calculado ao LLM é pedir aritmética de calendário, que é
 * onde ele mais erra e onde teste sai mais barato.
 */

const isoDate = z.string().refine(isIsoDate, { message: 'Data deve estar em YYYY-MM-DD.' });

const amountText = z
  .string()
  .min(1)
  .max(40)
  .describe('O valor exatamente como o usuário escreveu, ex: "80", "R$ 1.204,00", "40 conto".');

const dateExpression = z
  .string()
  .max(60)
  .nullable()
  .default(null)
  .describe(
    'A expressão de tempo LITERAL usada pelo usuário: "ontem", "sexta passada", "dia 28", ' +
      '"28/08". Null quando ele não mencionou quando foi. NÃO calcule a data.',
  );

export const TransactionsCreateSchema = z.object({
  amount: amountText,
  dateExpression,
  kind: z.enum(['expense', 'income']).default('expense'),
  categoryKey: z
    .string()
    .max(32)
    .nullable()
    .default(null)
    .describe('Chave de categoria da lista fornecida. Null se nenhuma se encaixa claramente.'),
  description: z
    .string()
    .max(300)
    .nullable()
    .default(null)
    .describe('Detalhe curto, quando o usuário deu um. Não repita a categoria aqui.'),
  spentByName: z
    .string()
    .max(60)
    .nullable()
    .default(null)
    .describe('Quem gastou, se o usuário mencionou outra pessoa. Null = quem está falando.'),
  rawText: z
    .string()
    .max(500)
    .describe('A frase original do usuário, copiada literalmente, sem edição.'),
});

export const TransactionsListSchema = z.object({
  from: isoDate.nullable().default(null),
  to: isoDate.nullable().default(null),
  categoryKey: z.string().max(32).nullable().default(null),
  limit: z.number().int().min(1).max(100).default(20),
});

export const TransactionsSummarizeSchema = z.object({
  from: isoDate.nullable().default(null).describe('Início do período. Null = mês corrente.'),
  to: isoDate.nullable().default(null),
  groupBy: z.enum(['category', 'person', 'total']).default('category'),
  categoryKey: z
    .string()
    .max(32)
    .nullable()
    .default(null)
    .describe('Para perguntas do tipo "quanto gastei em mercado".'),
});

/** Referência a um gasto já registrado, quando não se tem o id. */
const transactionRef = z
  .string()
  .min(1)
  .max(120)
  .describe(
    'Id do gasto, ou como o usuário se referiu a ele: "o último", "o do mercado", ' +
      '"aquele de 80 reais".',
  );

export const TransactionsUpdateSchema = z.object({
  transaction: transactionRef,
  amount: amountText.nullable().default(null),
  dateExpression,
  categoryKey: z.string().max(32).nullable().default(null),
  description: z.string().max(300).nullable().default(null),
  spentByName: z.string().max(60).nullable().default(null),
});

export const TransactionsDeleteSchema = z.object({
  transaction: transactionRef,
});

export const TRANSACTIONS_PAYLOAD_SCHEMAS = {
  'transactions.create': TransactionsCreateSchema,
  'transactions.list': TransactionsListSchema,
  'transactions.summarize': TransactionsSummarizeSchema,
  'transactions.update': TransactionsUpdateSchema,
  'transactions.delete': TransactionsDeleteSchema,
} as const;

export type TransactionsIntent = keyof typeof TRANSACTIONS_PAYLOAD_SCHEMAS;
