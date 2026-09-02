import 'server-only';

/**
 * Contratos entre agentes. Ver docs/architecture.md §2.
 *
 * Princípio: nenhum agente conversa com outro por texto solto. Todo salto passa
 * por estas estruturas, validadas por Zod na fronteira.
 */

export const AGENT_NAMES = ['bills', 'transactions', 'tasks', 'insights', 'memory'] as const;
export type AgentName = (typeof AGENT_NAMES)[number];

/**
 * Union fechada de intenções. O router só pode emitir valores daqui — é isso
 * que torna o golden set de roteamento verificável de forma binária.
 */
export const AGENT_INTENTS = [
  'bills.create',
  'bills.list',
  'bills.update',
  'bills.delete',
  'bills.mark_paid',
  'bills.overdue',

  'transactions.create',
  'transactions.list',
  'transactions.update',
  'transactions.delete',
  'transactions.summarize',

  'tasks.create',
  'tasks.list',
  'tasks.update',
  'tasks.complete',
  'tasks.delete',

  'insights.compare_periods',
  'insights.category_breakdown',
  'insights.budget_impact',
  'insights.recurring_cuts',
  'insights.anomalies',

  'memory.recall',
  'memory.write',
  'memory.forget',
] as const;
export type AgentIntent = (typeof AGENT_INTENTS)[number];

export const AGENT_BY_INTENT: Record<AgentIntent, AgentName> = Object.fromEntries(
  AGENT_INTENTS.map((intent) => [intent, intent.split('.')[0] as AgentName]),
) as Record<AgentIntent, AgentName>;

/**
 * Agentes com implementação real. `AGENT_INTENTS` acima é a taxonomia completa,
 * incluindo fases ainda não construídas.
 *
 * A distinção existe porque o golden set flagrou o roteador emitindo
 * `insights.compare_periods` para "quem gastou mais esse mês?" — uma intenção
 * válida no schema e sem agente por trás. O usuário receberia "isso entra numa
 * fase seguinte" para uma pergunta que o agente de Gastos responde hoje.
 *
 * Restringir aqui torna o erro impossível em vez de instruído: o modelo não
 * consegue nem propor a intenção. Ao ligar um agente novo, acrescente o nome
 * nesta lista — é o único ponto a mudar.
 */
export const ACTIVE_AGENTS = ['bills', 'transactions', 'tasks'] as const;
export type ActiveAgent = (typeof ACTIVE_AGENTS)[number];

export const ACTIVE_INTENTS = AGENT_INTENTS.filter((intent) =>
  (ACTIVE_AGENTS as readonly string[]).includes(AGENT_BY_INTENT[intent]),
) as AgentIntent[];

// ---------------------------------------------------------------------------
// Contexto
// ---------------------------------------------------------------------------

export interface RecalledMemory {
  id: string;
  content: string;
  kind: 'preference' | 'fact' | 'decision' | 'pattern';
  scope: 'user' | 'household';
  similarity: number;
}

export interface ConversationContext {
  /** Resumo rolante. Null enquanto a conversa é curta o bastante. */
  summary: string | null;
  /** Últimos turnos crus, já truncados. Nunca o histórico inteiro. */
  recentTurns: Array<{ role: 'user' | 'assistant'; content: string }>;
}

/**
 * Injetado pelo runner, nunca pelo LLM. O modelo não escolhe householdId —
 * é isso que fecha a porta para prompt injection escalar escopo.
 */
export interface AgentContext {
  householdId: string;
  userId: string;
  conversationId: string;
  /** Fuso do household. Toda resolução de "hoje"/"ontem" passa por aqui. */
  timezone: string;
  conversationContext: ConversationContext;
  /** Recuperadas uma única vez pelo nó recall_memory. Agentes não fazem retrieval. */
  memories: RecalledMemory[];
  /** Abortado quando o timeout do passo estoura. */
  signal: AbortSignal;
  /** Correlaciona todos os agent_runs de uma mesma mensagem do usuário. */
  traceId: string;
}

// ---------------------------------------------------------------------------
// Requisição / resposta
// ---------------------------------------------------------------------------

export interface AgentRequest<P = Record<string, unknown>> {
  ctx: AgentContext;
  intent: AgentIntent;
  payload: P;
}

export type AgentErrorCode =
  | 'VALIDATION'
  | 'NOT_FOUND'
  /** Não é falha: o agente precisa de desambiguação do usuário. */
  | 'AMBIGUOUS'
  | 'TIMEOUT'
  | 'LLM'
  | 'DB'
  | 'RATE_LIMITED'
  | 'UNKNOWN';

export interface AgentError {
  code: AgentErrorCode;
  /** Interno. Vai para log e agent_runs.error_code — nunca direto para a UI. */
  message: string;
  retryable: boolean;
}

/** Recurso tocado por uma escrita — dispara revalidação no dashboard. */
export type TouchedResource =
  | 'bills'
  | 'bill_occurrences'
  | 'transactions'
  | 'tasks'
  | 'memories';

/**
 * Componente visual renderizado inline no chat (docs/design.md §4.2).
 *
 * O bloco carrega os dados que precisa para renderizar, não só um id. Um bloco
 * com apenas `occurrenceId` obrigaria o cliente a um segundo fetch para
 * desenhar um card que o servidor acabou de montar — e a mostrar um esqueleto
 * no meio da conversa enquanto isso.
 */
export type UiBlock =
  | {
      type: 'bill_card';
      occurrenceId: string;
      title: string;
      amountCents: number;
      dueDate: string;
      status: 'pending' | 'paid' | 'cancelled';
    }
  | { type: 'transaction_card'; transactionId: string; label: string; amountCents: number; occurredOn: string }
  | { type: 'task_card'; taskId: string; title: string; dueDate: string | null }
  | { type: 'amount_comparison'; label: string; currentCents: number; baselineCents: number; baselineLabel: string }
  | { type: 'category_bars'; periodLabel: string; items: Array<{ label: string; cents: number }> };

/**
 * Fato candidato a virar memória duradoura. O agente que emite NÃO decide se
 * vira memória — quem decide é o Agente de Memória, depois da resposta.
 */
export interface MemoryCandidate {
  content: string;
  kind: 'preference' | 'fact' | 'decision' | 'pattern';
  scope: 'user' | 'household';
  source: 'chat' | 'correction' | 'derived';
  sourceRef?: string;
  confidence: number;
}

export type AgentResponse<D = Record<string, unknown>> =
  | {
      success: true;
      data: D;
      /**
       * Texto factual e seco para o orquestrador redigir a resposta final.
       * NÃO é a resposta ao usuário — não escrever em tom conversacional aqui.
       */
      summaryForOrchestrator: string;
      blocks?: UiBlock[];
      memoryCandidates?: MemoryCandidate[];
      touched?: TouchedResource[];
    }
  | {
      success: false;
      error: AgentError;
      /** O que dizer ao usuário sobre esta falha. Sem jargão técnico. */
      summaryForOrchestrator: string;
    };

export type SpecialistAgent = (req: AgentRequest) => Promise<AgentResponse>;

// ---------------------------------------------------------------------------
// Plano de execução (saída do router)
// ---------------------------------------------------------------------------

export interface PlanStep {
  id: string;
  agent: AgentName;
  intent: AgentIntent;
  payload: Record<string, unknown>;
  /** ids de passos que precisam terminar antes. Vazio = primeiro nível. */
  dependsOn: string[];
}

export interface ExecutionPlan {
  mode: 'direct' | 'delegate';
  /** Só quando mode = 'direct'. */
  directAnswer?: string;
  steps: PlanStep[];
  /** Por que roteou assim. Vai para agent_runs — é o que torna o golden set debugável. */
  rationale: string;
}

export type StepStatus = 'success' | 'error' | 'timeout' | 'skipped_by_dependency';

export interface StepResult {
  step: PlanStep;
  status: StepStatus;
  response: AgentResponse | null;
  durationMs: number;
  retried: boolean;
}

/** Timeout por agente, em ms. Ver docs/architecture.md §3.4. */
export const AGENT_TIMEOUT_MS: Record<AgentName, number> = {
  bills: 10_000,
  transactions: 12_000,
  tasks: 10_000,
  insights: 25_000,
  memory: 8_000,
};
