import 'server-only';

/**
 * Modelo por agente. Decisão registrada em docs/architecture.md §0.
 *
 * Escalonado de propósito: roteamento errado contamina tudo abaixo dele, então
 * o orquestrador não economiza; CRUD quase puro roda em Haiku; só o Insights,
 * que faz raciocínio analítico real, justifica Opus.
 *
 * Trocável por env var sem deploy — útil para medir custo x acerto no golden set.
 */

export const MODELS = {
  /** Router + synthesize. Não economizar aqui. */
  orchestrator: process.env['MODEL_ORCHESTRATOR'] ?? 'claude-sonnet-5',
  /** Extração de campos simples e bem delimitados. */
  bills: process.env['MODEL_BILLS'] ?? 'claude-haiku-4-5-20251001',
  /** Extração de valor/data/categoria em PT-BR informal — onde mais se erra. */
  transactions: process.env['MODEL_TRANSACTIONS'] ?? 'claude-sonnet-5',
  /** CRUD quase puro. */
  tasks: process.env['MODEL_TASKS'] ?? 'claude-haiku-4-5-20251001',
  /** Classificação binária "isso é memória duradoura?". */
  memory: process.env['MODEL_MEMORY'] ?? 'claude-haiku-4-5-20251001',
  /** Único agente com raciocínio analítico sobre agregados. */
  insights: process.env['MODEL_INSIGHTS'] ?? 'claude-opus-5',
} as const satisfies Record<string, string>;

export type ModelSlot = keyof typeof MODELS;

/** Teto de tokens de saída por slot. Contém custo e corta loop patológico. */
export const MAX_OUTPUT_TOKENS: Record<ModelSlot, number> = {
  orchestrator: 2_000,
  bills: 1_000,
  transactions: 1_000,
  tasks: 1_000,
  memory: 1_000,
  insights: 3_000,
};
