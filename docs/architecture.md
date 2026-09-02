# Arquitetura — Assistente Financeiro Familiar

Documento vivo. Toda decisão aqui é revisável, mas nenhuma deve ser contrariada em código sem
atualizar este arquivo.

## 0. Decisões travadas (2026-09-02)

| Decisão | Escolha | Consequência |
|---|---|---|
| Notificações | Somente in-app | `notifications` existe no schema com coluna `channel`, mas só `in_app` é implementado. Cron/e-mail entram depois sem migração. |
| Modelos | Escalonado por agente | Ver `src/server/llm/models.ts`. Trocável por env var, sem deploy. |
| Resumo de conversa | Regra simples agora, LLM na Fase 5 | Interface `ConversationSummarizer` com duas implementações. |
| Household | 2–4 pessoas, papéis admin/membro | Sem hierarquia extra, sem múltiplos households por usuário. |

### Modelo por agente

| Agente | Modelo | Justificativa |
|---|---|---|
| Orquestrador (router + synthesize) | `claude-sonnet-5` | Roteamento errado contamina tudo abaixo. Não economizar aqui. |
| Contas a Pagar | `claude-haiku-4-5-20251001` | Extração de campos simples e bem delimitados. |
| Gastos (Transações) | `claude-sonnet-5` | Extração de valor/data/categoria em PT-BR informal é onde mais se erra. |
| Tarefas | `claude-haiku-4-5-20251001` | CRUD quase puro. |
| Memória | `claude-haiku-4-5-20251001` | Classificação binária "isso é memória duradoura?". |
| Insights | `claude-opus-5` | Único agente que faz raciocínio analítico real sobre agregados. |

---

## 1. Princípios não negociáveis

1. **Nenhum agente conversa com outro por texto solto.** Todo salto entre agentes passa por
   `AgentRequest` / `AgentResponse` tipados e validados com Zod na fronteira.
2. **Lógica de negócio não depende de LLM.** "Esta conta está em atraso?", "quanto gastamos em
   delivery em agosto?" são funções puras / queries SQL testáveis sem chamar modelo. O LLM só
   traduz linguagem natural ↔ estrutura e redige a resposta final.
3. **O agente de Insights nunca afirma número que não veio de uma query.** Toda afirmação carrega
   o dado que a sustenta; o sintetizador é proibido de introduzir números ausentes.
4. **Falha nunca vira invenção.** Se um agente falha, a resposta final diz explicitamente o que não
   foi possível fazer. Resposta parcial honesta > resposta completa fabricada.
5. **Nada que toque service role ou o modelo roda no cliente.** Garantido mecanicamente pelo pacote
   `server-only` importado no topo de `src/server/**`.

---

## 2. Contratos entre agentes

```ts
// src/server/agents/shared/contracts.ts

/** Identidade + escopo. Sempre derivado da sessão no servidor, nunca do body da request. */
export interface AgentContext {
  householdId: string;
  userId: string;
  conversationId: string;
  /** Resumo + últimos turnos. Nunca o histórico cru completo. */
  conversationContext: ConversationContext;
  /** Memórias já recuperadas pelo nó recall_memory. Agentes NÃO fazem retrieval por conta. */
  memories: RecalledMemory[];
  /** Abortado quando o timeout do passo estoura. */
  signal: AbortSignal;
  /** Correlaciona todos os agent_runs de uma mesma mensagem. */
  traceId: string;
}

export interface AgentRequest<P = Record<string, unknown>> {
  ctx: AgentContext;
  /** Intenção já classificada pelo orquestrador, ex: "bills.create". */
  intent: AgentIntent;
  /** Payload específico da intenção. Validado por um schema Zod por intent. */
  payload: P;
}

export type AgentResponse<D = Record<string, unknown>> =
  | {
      success: true;
      data: D;
      /** Texto factual e seco que o orquestrador usa para redigir. Não é a resposta ao usuário. */
      summaryForOrchestrator: string;
      /** Componentes visuais que o chat pode renderizar inline. */
      blocks?: UiBlock[];
      memoryCandidates?: MemoryCandidate[];
      /** Tabelas afetadas — dispara revalidação/realtime no dashboard. */
      touched?: TouchedResource[];
    }
  | {
      success: false;
      error: AgentError;
      /** O que dizer ao usuário sobre esta falha específica. Sem jargão técnico. */
      summaryForOrchestrator: string;
    };

export interface AgentError {
  code: AgentErrorCode; // 'VALIDATION' | 'NOT_FOUND' | 'AMBIGUOUS' | 'TIMEOUT' | 'LLM' | 'DB' | 'UNKNOWN'
  message: string;      // interno, vai para log — nunca direto para a UI
  retryable: boolean;
}
```

`AgentIntent` é uma union fechada (`'bills.create' | 'bills.list' | ... | 'insights.compare'`).
O router só pode emitir valores dessa union — isso é o que torna o golden set de roteamento
verificável de forma binária.

**Por que `AgentContext` separado do `payload`:** o contexto é injetado pelo runner, não pelo LLM.
O modelo nunca escolhe `householdId`. Isso fecha a porta para um prompt injection escalar escopo.

---

## 3. Grafo do LangGraph

```
                        ┌──────────────┐
   mensagem do usuário → │    ingest    │  carrega sessão, conversa, resumo, últimos N turnos
                        └──────┬───────┘  (sem LLM)
                               │
                        ┌──────▼───────┐
                        │ recall_memory│  embedding da mensagem → top-k memórias do household
                        └──────┬───────┘  (sem LLM generativo, só embedding)
                               │
                        ┌──────▼───────┐
                        │    route     │  LLM structured output → ExecutionPlan
                        └──────┬───────┘
                               │
                  ┌────────────┴────────────┐
      mode=direct  │                        │  mode=delegate
                  │                        │
                  │                 ┌──────▼────────┐
                  │                 │ execute_plan  │◄─────────┐  despacha 1 nível do DAG
                  │                 └──────┬────────┘          │
                  │                        │                   │
                  │        ┌───────┬───────┼───────┬────────┐  │
                  │        │       │       │       │        │  │  (paralelo dentro do nível)
                  │     ┌──▼──┐ ┌──▼──┐ ┌──▼──┐ ┌──▼───┐ ┌──▼──┴──┐
                  │     │bills│ │trans│ │tasks│ │insig.│ │ memory │
                  │     └──┬──┘ └──┬──┘ └──┬──┘ └──┬───┘ └────┬───┘
                  │        └───────┴───────┼───────┴──────────┘
                  │                        │
                  │                  plano exaurido?
                  │                    não ──────────────────────┘
                  │                     sim
                  │                        │
                  └────────────┬───────────┘
                               │
                        ┌──────▼───────┐
                        │  synthesize  │  LLM → resposta única + UiBlocks
                        └──────┬───────┘  recebe explicitamente o que falhou
                               │
                        ┌──────▼───────┐
                        │   persist    │  messages, agent_runs, resumo rolante
                        └──────┬───────┘  (sem LLM)
                               │
                          ► resposta streamada ao usuário
                               │
                        ┌──────▼───────┐
                        │ memory_write │  pós-resposta (waitUntil). Falha aqui NUNCA
                        └──────────────┘  afeta a resposta já entregue.
```

### 3.1 `route` — direto vs delegar

O router produz um `ExecutionPlan`, não um único nome de agente:

```ts
interface ExecutionPlan {
  mode: 'direct' | 'delegate';
  /** Preenchido só quando mode='direct'. */
  directAnswer?: string;
  steps: PlanStep[];
  /** Por que roteou assim. Vai para agent_runs, é o que torna o golden set debugável. */
  rationale: string;
}

interface PlanStep {
  id: string;                 // 's1', 's2'
  agent: AgentName;
  intent: AgentIntent;
  payload: Record<string, unknown>;
  /** ids de passos que precisam terminar antes. Vazio = pode rodar no primeiro nível. */
  dependsOn: string[];
}
```

`mode: 'direct'` só é permitido quando **todas** as condições valem:
- a mensagem não pede nenhuma escrita no banco;
- a resposta é derivável do `conversationContext` + `memories` já em mãos;
- não há número financeiro na resposta que não esteja literalmente no contexto.

Ou seja: "obrigado", "o que você consegue fazer?", "aquela conta que falei era a do Bruno mesmo?"
→ direto. Qualquer coisa que precise consultar ou gravar dado → `delegate`, mesmo que pareça trivial.
Essa regra é deliberadamente conservadora: o custo de uma chamada extra a Haiku é irrelevante perto
do custo de o assistente chutar um saldo.

### 3.2 Multi-agente e dependência

Exemplo do brief: *"cadastra essa conta de luz de 340 reais pro dia 15 e me diz se isso vai estourar
meu orçamento do mês"*.

```json
{
  "mode": "delegate",
  "steps": [
    { "id": "s1", "agent": "bills", "intent": "bills.create",
      "payload": { "title": "Conta de luz", "amountCents": 34000, "dueDate": "2026-09-15" },
      "dependsOn": [] },
    { "id": "s2", "agent": "insights", "intent": "insights.budget_impact",
      "payload": { "period": "current_month", "includeBillOccurrenceId": "$steps.s1.data.occurrenceId" },
      "dependsOn": ["s1"] }
  ],
  "rationale": "Escrita de conta seguida de análise que depende do registro recém-criado."
}
```

O dispatcher resolve `$steps.<id>.<path>` no momento do despacho, a partir do `data` já retornado.
Referência a passo inexistente ou a caminho ausente = erro de validação do plano, não crash.

Paralelismo: *"quanto gastamos em mercado esse mês e quais contas vencem semana que vem?"* →
dois passos com `dependsOn: []`, executados no mesmo nível com `Promise.allSettled`.

### 3.3 Onde entra a memória

**Retrieval acontece uma vez, antes do `route`.** Duas razões:

1. A memória pode mudar o roteamento, não só a redação. Se existe a memória *"a família decidiu em
   julho manter a Netflix, já discutimos"*, uma pergunta sobre corte de assinaturas deve produzir um
   plano diferente — e isso precisa estar disponível ao router, não só ao sintetizador.
2. Um único embedding por mensagem, compartilhado por todos os agentes. Se cada agente fizesse o
   próprio retrieval, teríamos N embeddings por turno e resultados inconsistentes entre agentes na
   mesma resposta.

**Escrita acontece depois da resposta**, fora do caminho crítico. Os agentes emitem
`memoryCandidates` (sem embedding, sem julgamento); o Agente de Memória decide o que promove a
memória duradoura, deduplica contra o que já existe (similaridade > 0.92 → atualiza em vez de
inserir) e gera os embeddings.

### 3.4 Erros

Política em três camadas:

**Por passo.** Timeout explícito (`bills`/`tasks`: 10s, `transactions`: 12s, `insights`: 25s,
`memory`: 8s). Retry apenas uma vez e apenas quando `retryable = true` — rede, 429, 5xx, timeout.
Erro de validação, `NOT_FOUND` e `AMBIGUOUS` **nunca** são retentados; retentar um prompt que já
produziu saída inválida só queima dinheiro.

**Por plano.** Passo que falha marca os dependentes como `skipped_by_dependency`. Passos
independentes continuam. O plano nunca aborta inteiro por causa de um ramo.

**Na síntese.** `synthesize` **sempre** roda e recebe a lista explícita de passos falhos com a
`summaryForOrchestrator` de cada um. O prompt obriga: relatar o que funcionou, nomear o que não
funcionou, não especular sobre o que falhou. Se o próprio `synthesize` falhar, cai num fallback
determinístico que concatena as `summaryForOrchestrator` — feio, mas verdadeiro e sem LLM.

`AMBIGUOUS` é um caso à parte: não é falha, é o agente pedindo desambiguação
("achei duas contas chamadas 'internet'"). O sintetizador transforma isso em pergunta ao usuário.

---

## 4. Modelo de dados

Nomes divergentes do brief, com motivo:

- **`profiles` em vez de `users`** — `public.users` convivendo com `auth.users` é fonte garantida de
  confusão em policy e em join. `profiles.id` referencia `auth.users.id`.
- **`bills` + `bill_occurrences`** — uma conta recorrente é uma *definição*; cada vencimento é uma
  *ocorrência* com status próprio. Sem isso, não existe histórico de pagamento (o Insights da Fase 6
  precisa dele) e "está em atraso" vira gambiarra de data. Conta avulsa = definição com exatamente
  uma ocorrência. O dashboard sempre lê `bill_occurrences`, nunca `bills` — consulta uniforme.

**Dinheiro é `bigint` em centavos.** Nunca `float`, nunca `numeric` lido como número em JS. Toda
aritmética é inteira; formatação BRL só na borda de renderização. O extrator de linguagem natural
devolve centavos, e o schema Zod rejeita não-inteiro.

Tabelas: `households`, `profiles`, `categories`, `bills`, `bill_occurrences`, `transactions`,
`transaction_corrections`, `tasks`, `memories`, `conversations`, `messages`, `agent_runs`,
`notifications`, `notification_preferences`, `rate_limits`.

`transaction_corrections` existe porque o brief pede que a correção de categoria pelo usuário vire
sinal de aprendizado — ela é a fonte de `memoryCandidates` do tipo `pattern`.

### Índices pensados desde o início

| Índice | Consulta que atende |
|---|---|
| `bill_occurrences (household_id, due_date)` | agenda do dashboard |
| `bill_occurrences (household_id, status, due_date) WHERE status = 'pending'` | parcial; "o que vence" e detecção de atraso |
| `bill_occurrences (bill_id, due_date)` UNIQUE | impede geração duplicada de ocorrência |
| `transactions (household_id, occurred_on DESC)` | últimos gastos |
| `transactions (household_id, category_id, occurred_on)` | consolidação por categoria/período |
| `transactions (household_id, spent_by, occurred_on)` | consolidação por pessoa |
| `messages (conversation_id, created_at DESC)` | janela recente da conversa |
| `memories` HNSW `vector_cosine_ops` + btree `(household_id, scope)` | retrieval semântico |
| `agent_runs (household_id, created_at DESC)`, `(agent, status, created_at DESC)` | observabilidade |

### RLS

Toda tabela com `household_id` tem RLS ligado e policy escopada. Para evitar recursão de policy
(policy em `profiles` que consulta `profiles`), o escopo vem de uma função `SECURITY DEFINER STABLE`:

```sql
create function public.current_household_id() returns uuid
language sql stable security definer set search_path = public as $$
  select household_id from public.profiles where id = auth.uid()
$$;
```

Policies usam `household_id = public.current_household_id()`. `memories` com `scope = 'user'`
exigem adicionalmente `owner_id = auth.uid()`.

O isolamento é **testado**, não assumido: `tests/rls/isolation.test.ts` cria dois households
fictícios com dados e verifica, com o token de cada um, que leitura, escrita e busca vetorial cruzada
retornam vazio ou erro.

### Direito ao esquecimento

`memories`, `messages` e `transactions` usam **hard delete**. Não há `deleted_at`. Apagar uma memória
apaga a linha e, com ela, o embedding (mesma linha). Um `DELETE` em `conversations` cascateia para
`messages`. Nada de "esconder na UI".

---

## 5. Segurança operacional

- Chaves só em env var da Vercel. `.env.local` no `.gitignore` desde o primeiro commit.
- `src/server/**` importa `server-only`; qualquer import acidental a partir de client component
  quebra o build, não o runtime em produção.
- Service role client existe em exatamente um arquivo (`src/server/db/admin.ts`) e é usado só onde
  RLS precisa ser contornada de propósito (cron de geração de ocorrências). Todo o resto usa o
  client com o JWT do usuário — RLS é a segunda linha de defesa, não a única.
- Zod em toda fronteira: body da rota de chat, saída estruturada de cada LLM, payload de cada intent.
- Rate limit em Postgres (tabela `rate_limits`, janela deslizante por `user_id`), não em serviço
  externo. Volume é familiar; um Redis a mais é superfície sem ganho. Limite inicial: 30 mensagens /
  10 min por usuário, 300 / dia por household.
- `agent_runs` guarda metadado apenas: agente, intent, status, duração, código de erro, modelo,
  tokens. **Nunca** valor, descrição, título de conta ou conteúdo de mensagem.

---

## 6. Testes

```
tests/
  unit/                 lógica pura, sem rede, sem LLM
    bills/overdue.test.ts, recurrence.test.ts, duplicate-detection.test.ts
    transactions/aggregate.test.ts
    money.test.ts, dates.test.ts
    orchestrator/plan-validation.test.ts, dependency-resolution.test.ts
  rls/isolation.test.ts        dois households fictícios, isolamento real
  eval/                        chamam modelo; fora do CI padrão
    routing/golden-set.json    ~30 mensagens → intent + agentes esperados
    routing/routing.eval.ts    falha se acurácia < limiar
    extraction/dataset.json    frases PT-BR → { valor, categoria, data } esperados
    extraction/extraction.eval.ts
    insights/REVIEW.md         revisão manual, com checklist
```

`npm test` roda `unit/` (rápido, determinístico, CI-safe). `npm run eval` roda `eval/` sob demanda,
com custo de modelo. `npm run test:rls` precisa de um Supabase alcançável.

O golden set de roteamento é o gate: **todo PR que altera o prompt do orquestrador precisa rodá-lo**,
e a acurácia não pode cair.
