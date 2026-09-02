import { z } from 'zod';
import { isIsoDate } from '@/lib/dates';

/**
 * Payload por intenção do Agente de Contas.
 *
 * Decisão que vale explicar: o valor chega como **texto**, do jeito que a pessoa
 * escreveu ("340", "R$ 1.204,00", "40 conto"), e é convertido para centavos pelo
 * `parseBRLToCents`, que tem teste. O modelo não faz aritmética monetária — ele
 * só recorta a string. Pedir `amountCents` ao LLM é convidar a errar duas casas
 * decimais numa conta de luz.
 */

const isoDate = z.string().refine(isIsoDate, {
  message: 'Data deve estar em YYYY-MM-DD.',
});

/** Texto monetário cru, como a pessoa falou. Convertido no agente. */
const amountText = z
  .string()
  .min(1)
  .max(40)
  .describe('O valor exatamente como o usuário escreveu, ex: "340", "R$ 1.204,00", "40 conto".');

const recurrence = z.enum(['none', 'weekly', 'monthly', 'quarterly', 'yearly']);

/** Referência a uma conta: por id, quando conhecido, ou pelo nome dito. */
const billRef = z
  .string()
  .min(1)
  .max(120)
  .describe('Id da conta, ou o nome como o usuário se referiu a ela, ex: "luz", "internet".');

export const BillsCreateSchema = z.object({
  title: z.string().trim().min(1).max(120),
  amount: amountText,
  dueDate: isoDate.describe('Data do primeiro (ou único) vencimento.'),
  recurrence: recurrence.default('none'),
  recurrenceDay: z
    .number()
    .int()
    .min(1)
    .max(31)
    .nullable()
    .default(null)
    .describe('Dia do mês para recorrência mensal/trimestral/anual. Null para avulsa e semanal.'),
  categoryKey: z.string().max(32).nullable().default(null),
  responsibleName: z
    .string()
    .max(60)
    .nullable()
    .default(null)
    .describe('Nome da pessoa responsável, se o usuário mencionou.'),
  notes: z.string().max(1000).nullable().default(null),
  /**
   * Só o orquestrador seta isto, e só depois de o usuário confirmar que não é
   * duplicata. O modelo nunca deve preencher na primeira tentativa.
   */
  confirmDuplicate: z.boolean().default(false),
});

/**
 * Única intenção de leitura de contas.
 *
 * Havia uma `bills.upcoming` separada, removida depois que o golden set mostrou
 * que ela e `bills.list` produzem o mesmo dado e o roteador alternava entre as
 * duas conforme a redação da frase. Duas intenções que fazem o mesmo trabalho
 * geram ruído de roteamento que nenhum ajuste de prompt resolve.
 *
 * `from` nulo é o caso comum e o padrão: uma conta vencida do mês passado
 * continua sendo a mais urgente e não pode sumir da lista por causa de um filtro
 * de início de janela.
 */
export const BillsListSchema = z.object({
  status: z.enum(['pending', 'paid', 'cancelled', 'all']).default('pending'),
  from: isoDate
    .nullable()
    .default(null)
    .describe('Só quando o usuário delimitar o INÍCIO de um período passado. Normalmente null.'),
  to: isoDate
    .nullable()
    .default(null)
    .describe('Fim da janela, quando o usuário disser "essa semana", "até dia 20", "nesse mês".'),
  limit: z.number().int().min(1).max(100).default(50),
});

export const BillsOverdueSchema = z.object({});

export const BillsUpdateSchema = z.object({
  bill: billRef,
  title: z.string().trim().min(1).max(120).nullable().default(null),
  amount: amountText.nullable().default(null),
  dueDate: isoDate.nullable().default(null),
  recurrence: recurrence.nullable().default(null),
  recurrenceDay: z.number().int().min(1).max(31).nullable().default(null),
  categoryKey: z.string().max(32).nullable().default(null),
  responsibleName: z.string().max(60).nullable().default(null),
});

export const BillsMarkPaidSchema = z.object({
  bill: billRef,
  paidOn: isoDate.nullable().default(null).describe('Quando foi paga. Null = hoje.'),
  amount: amountText.nullable().default(null).describe('Valor efetivamente pago, se diferente.'),
});

export const BillsDeleteSchema = z.object({
  bill: billRef,
  /** Apagar a definição inteira ou só a ocorrência deste mês. */
  scope: z.enum(['occurrence', 'bill']).default('bill'),
});

export const BILLS_PAYLOAD_SCHEMAS = {
  'bills.create': BillsCreateSchema,
  'bills.list': BillsListSchema,
  'bills.overdue': BillsOverdueSchema,
  'bills.update': BillsUpdateSchema,
  'bills.mark_paid': BillsMarkPaidSchema,
  'bills.delete': BillsDeleteSchema,
} as const;

export type BillsIntent = keyof typeof BILLS_PAYLOAD_SCHEMAS;
