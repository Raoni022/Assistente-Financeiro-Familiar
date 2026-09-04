import 'server-only';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { billsAgent } from '@/server/agents/bills/agent';
import { recallMemories } from '@/server/agents/memory/agent';
import { tasksAgent } from '@/server/agents/tasks/agent';
import { transactionsAgent } from '@/server/agents/transactions/agent';
import type {
  AgentContext,
  AgentName,
  ExecutionPlan,
  MemoryCandidate,
  PlanStep,
  SpecialistAgent,
  StepResult,
  TouchedResource,
  UiBlock,
} from '@/server/agents/shared/contracts';
import { resolveLevels, resolveReferences, stepsBlockedBy, PlanError } from '@/server/agents/shared/plan';
import { logAgentRun, runStep } from '@/server/agents/shared/run-agent';
import { createClient } from '@/server/db/server';
import { createVoyageProvider } from '@/server/embeddings/voyage';
import { routePlan } from './router';
import { synthesize } from './synthesize';

/**
 * Grafo do orquestrador. Diagrama e racional em docs/architecture.md §3.
 *
 *   recall_memory → route → execute ⇄ execute → synthesize → END
 *                      └────── direct ──────────┘
 *
 * `recall_memory` busca memórias ANTES do roteamento, não depois: memória pode
 * mudar o PLANO (ex: "a família já decidiu manter a Netflix"), não só a
 * redação da resposta final. A escrita de memória (memoryCandidates emitidos
 * pelos agentes) roda fora deste grafo, depois da resposta já entregue — ver
 * `after()` em src/app/api/chat/route.ts.
 */

const AGENTS: Record<AgentName, SpecialistAgent> = {
  bills: billsAgent,
  transactions: transactionsAgent,
  tasks: tasksAgent,
  // Fase 6. Até lá o roteador não emite intenções deste agente.
  insights: notImplemented('insights'),
  // Nunca chamado por aqui — memória é transversal, não um passo de plano.
  // Ver recallMemories/persistMemoryCandidates em agents/memory/agent.ts.
  memory: notImplemented('memory'),
};

function notImplemented(name: AgentName): SpecialistAgent {
  return async () => ({
    success: false,
    error: { code: 'VALIDATION', message: `agente ${name} não implementado`, retryable: false },
    summaryForOrchestrator: `Ainda não sei fazer isso — o agente de ${name} entra numa fase seguinte.`,
  });
}

const OrchestratorState = Annotation.Root({
  userMessage: Annotation<string>,
  ctx: Annotation<Omit<AgentContext, 'signal' | 'memories'>>,
  memories: Annotation<AgentContext['memories']>({
    reducer: (_prev, next) => next,
    default: () => [],
  }),
  plan: Annotation<ExecutionPlan | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  /** Objeto, não Map: o merge de estado do LangGraph lida melhor com ele. */
  stepResults: Annotation<Record<string, StepResult>>({
    reducer: (prev, next) => ({ ...prev, ...next }),
    default: () => ({}),
  }),
  finalText: Annotation<string>({ reducer: (_p, n) => n, default: () => '' }),
  blocks: Annotation<UiBlock[]>({ reducer: (p, n) => [...p, ...n], default: () => [] }),
  touched: Annotation<TouchedResource[]>({ reducer: (p, n) => [...p, ...n], default: () => [] }),
  memoryCandidates: Annotation<MemoryCandidate[]>({
    reducer: (p, n) => [...p, ...n],
    default: () => [],
  }),
});

type State = typeof OrchestratorState.State;

// ---------------------------------------------------------------------------
// Nós
// ---------------------------------------------------------------------------

async function recallMemory(state: State): Promise<Partial<State>> {
  // Client autenticado com o JWT do usuário: match_memories é SECURITY INVOKER
  // e a RLS decide o que é visível — nunca service role aqui.
  const supabase = await createClient();
  const memories = await recallMemories(supabase, createVoyageProvider(), state.userMessage);
  return { memories };
}

async function route(state: State): Promise<Partial<State>> {
  const plan = await routePlan(state.userMessage, { ...state.ctx, memories: state.memories });
  return { plan };
}

async function execute(state: State): Promise<Partial<State>> {
  const plan = state.plan;
  if (!plan || plan.mode === 'direct') return {};

  const done = new Map(Object.entries(state.stepResults));
  const levels = resolveLevels(plan.steps);
  const nextLevel = levels.find((level) => level.some((step) => !done.has(step.id)));
  if (!nextLevel) return {};

  const failedIds = new Set(
    [...done.values()].filter((result) => result.status !== 'success').map((r) => r.step.id),
  );
  const blocked = stepsBlockedBy(failedIds, plan.steps);

  const pending = nextLevel.filter((step) => !done.has(step.id));

  // Promise.all e não allSettled: runStep já captura toda falha e devolve um
  // StepResult. Se algo escapar dele, é bug nosso e deve estourar visível.
  const results = await Promise.all(
    pending.map((step) => executeStep(step, state, done, blocked)),
  );

  const merged: Record<string, StepResult> = {};
  const blocks: UiBlock[] = [];
  const touched: TouchedResource[] = [];
  const memoryCandidates: MemoryCandidate[] = [];

  for (const result of results) {
    merged[result.step.id] = result;
    if (result.response?.success) {
      blocks.push(...(result.response.blocks ?? []));
      touched.push(...(result.response.touched ?? []));
      memoryCandidates.push(...(result.response.memoryCandidates ?? []));
    }
  }

  return { stepResults: merged, blocks, touched, memoryCandidates };
}

async function executeStep(
  step: PlanStep,
  state: State,
  done: Map<string, StepResult>,
  blocked: Set<string>,
): Promise<StepResult> {
  const ctx = { ...state.ctx, memories: state.memories };

  // Dependência falhou: não roda, mas registra — o sintetizador precisa saber
  // exatamente o que ficou de fora para poder dizer ao usuário.
  if (blocked.has(step.id)) {
    await logAgentRun({
      householdId: ctx.householdId,
      traceId: ctx.traceId,
      conversationId: ctx.conversationId,
      agent: step.agent,
      intent: step.intent,
      status: 'skipped',
      durationMs: 0,
      errorCode: 'DEPENDENCY_FAILED',
      retried: false,
    });

    return {
      step,
      status: 'skipped_by_dependency',
      response: {
        success: false,
        error: { code: 'UNKNOWN', message: 'dependência falhou', retryable: false },
        summaryForOrchestrator: 'Não foi possível fazer esta parte porque a anterior falhou.',
      },
      durationMs: 0,
      retried: false,
    };
  }

  let resolvedStep = step;
  try {
    resolvedStep = { ...step, payload: resolveReferences(step.payload, done) };
  } catch (error) {
    if (!(error instanceof PlanError)) throw error;
    return {
      step,
      status: 'error',
      response: {
        success: false,
        error: { code: 'VALIDATION', message: error.message, retryable: false },
        summaryForOrchestrator: 'Não consegui encadear esta parte com o resultado anterior.',
      },
      durationMs: 0,
      retried: false,
    };
  }

  return runStep(AGENTS[step.agent], resolvedStep, ctx);
}

async function synthesizeNode(state: State): Promise<Partial<State>> {
  const plan = state.plan;

  if (plan?.mode === 'direct' && plan.directAnswer) {
    return { finalText: plan.directAnswer };
  }

  const results = Object.values(state.stepResults);
  const text = await synthesize(state.userMessage, results, {
    ...state.ctx,
    memories: state.memories,
  });
  return { finalText: text };
}

// ---------------------------------------------------------------------------
// Arestas
// ---------------------------------------------------------------------------

function afterRoute(state: State): 'execute' | 'synthesize' {
  return state.plan?.mode === 'delegate' ? 'execute' : 'synthesize';
}

/** Volta para `execute` enquanto houver nível pendente no DAG. */
function afterExecute(state: State): 'execute' | 'synthesize' {
  const plan = state.plan;
  if (!plan || plan.mode === 'direct') return 'synthesize';

  const done = new Set(Object.keys(state.stepResults));
  return plan.steps.every((step) => done.has(step.id)) ? 'synthesize' : 'execute';
}

export function buildOrchestrator() {
  return new StateGraph(OrchestratorState)
    .addNode('recall_memory', recallMemory)
    .addNode('route', route)
    .addNode('execute', execute)
    .addNode('synthesize', synthesizeNode)
    .addEdge(START, 'recall_memory')
    .addEdge('recall_memory', 'route')
    .addConditionalEdges('route', afterRoute, ['execute', 'synthesize'])
    .addConditionalEdges('execute', afterExecute, ['execute', 'synthesize'])
    .addEdge('synthesize', END)
    .compile();
}

export interface OrchestratorResult {
  text: string;
  blocks: UiBlock[];
  touched: TouchedResource[];
  plan: ExecutionPlan | null;
  stepResults: StepResult[];
  /** Fatos candidatos a memória duradoura. Gravados fora do caminho crítico —
   *  ver `after()` em src/app/api/chat/route.ts. */
  memoryCandidates: MemoryCandidate[];
}

export async function runOrchestrator(
  userMessage: string,
  ctx: Omit<AgentContext, 'signal' | 'memories'>,
): Promise<OrchestratorResult> {
  const graph = buildOrchestrator();

  const final = await graph.invoke(
    { userMessage, ctx },
    // Teto de segurança: o loop de execute é limitado pelo tamanho do plano
    // (máximo 6 passos), mas um bug de aresta não deve girar para sempre.
    { recursionLimit: 20 },
  );

  return {
    text: final.finalText,
    blocks: final.blocks,
    touched: [...new Set(final.touched)],
    plan: final.plan,
    stepResults: Object.values(final.stepResults),
    memoryCandidates: final.memoryCandidates,
  };
}
