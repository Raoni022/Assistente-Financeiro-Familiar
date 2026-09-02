import { z } from 'zod';

/**
 * Payload por intenção do Agente de Tarefas.
 *
 * Como nas fases anteriores, o modelo **recorta** e o código **converte**:
 * `deadlineExpression` leva o texto literal do prazo, resolvido depois por
 * `resolveDeadline`. Aqui a diferença é que o resolvedor olha para o futuro.
 */

const deadlineExpression = z
  .string()
  .max(60)
  .nullable()
  .default(null)
  .describe(
    'A expressão de prazo LITERAL usada pelo usuário: "amanhã", "sexta que vem", ' +
      '"dia 15", "semana que vem", "15/10". Null quando ele não deu prazo. NÃO calcule a data.',
  );

export const TasksCreateSchema = z.object({
  title: z.string().trim().min(1).max(160),
  description: z.string().max(2000).nullable().default(null),
  deadlineExpression,
  assigneeName: z
    .string()
    .max(60)
    .nullable()
    .default(null)
    .describe('Quem ficou responsável, se o usuário mencionou. Null = quem está falando.'),
  relatedBill: z
    .string()
    .max(120)
    .nullable()
    .default(null)
    .describe(
      'Nome da conta a que a tarefa se refere, quando houver: "renegociar o cartão" → "cartão". ' +
        'Null quando a tarefa não tem conta associada.',
    ),
});

export const TasksListSchema = z.object({
  status: z.enum(['todo', 'doing', 'done', 'cancelled', 'open', 'all']).default('open'),
  assigneeName: z.string().max(60).nullable().default(null),
  limit: z.number().int().min(1).max(100).default(30),
});

const taskRef = z
  .string()
  .min(1)
  .max(160)
  .describe('Id da tarefa, ou como o usuário se referiu a ela: "ligar pro banco", "a última".');

export const TasksUpdateSchema = z.object({
  task: taskRef,
  title: z.string().trim().min(1).max(160).nullable().default(null),
  description: z.string().max(2000).nullable().default(null),
  deadlineExpression,
  assigneeName: z.string().max(60).nullable().default(null),
  status: z.enum(['todo', 'doing', 'done', 'cancelled']).nullable().default(null),
});

export const TasksCompleteSchema = z.object({
  task: taskRef,
});

export const TasksDeleteSchema = z.object({
  task: taskRef,
});

export const TASKS_PAYLOAD_SCHEMAS = {
  'tasks.create': TasksCreateSchema,
  'tasks.list': TasksListSchema,
  'tasks.update': TasksUpdateSchema,
  'tasks.complete': TasksCompleteSchema,
  'tasks.delete': TasksDeleteSchema,
} as const;

export type TasksIntent = keyof typeof TASKS_PAYLOAD_SCHEMAS;
