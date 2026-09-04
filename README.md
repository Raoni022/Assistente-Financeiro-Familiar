# Assistente Financeiro Familiar

Sistema multi-agente de assistência financeira para uso da família. Next.js + Supabase + LangGraph.

- **Arquitetura, grafo de agentes, contratos e modelo de dados:** [`docs/architecture.md`](docs/architecture.md)
- **Sistema de design, paleta, tipografia e wireframes:** [`docs/design.md`](docs/design.md)

## Estado atual

| Fase | Escopo | Status |
|---|---|---|
| 1 | Fundação: setup, schema + RLS, auth, shell visual | código completo — **RLS básica confirmada** (`db:check` verde contra Supabase real); **isolamento entre households ainda não testado** (`test:rls` pulado — falta um segundo projeto) |
| 2 | Orquestrador + Agente de Contas | código completo — **roteamento medido: 53/54 (98,1%)** |
| 3 | Agente de Gastos + avaliação de extração | **completo e medido: 32/32 (100%)** nos quatro campos (valor, data, categoria, tipo) |
| 4 | Agente de Tarefas | código completo — não medido (golden set cobre os casos, não rodado após a Fase 4) |
| 5 | Memória semântica (pgvector + Voyage AI) | código completo — **não testado de ponta a ponta** (precisa de sessão logada de verdade; ver abaixo) |
| 6 | Insights | não iniciada — por definição do próprio plano, depende de meses de dado real |

**Concluído na Fase 1:** dependências, TypeScript estrito, Tailwind v4, tokens de design, contratos
de agente, migração de schema com RLS, auth por e-mail+senha, onboarding (criar casa / entrar por
convite), shell visual completo (dashboard + chat flutuante) e a suíte de isolamento de RLS escrita.
`npm run db:check` já passou contra um Supabase real: 16 tabelas, seed de categorias, pgvector com
`match_memories` respondendo, e nenhuma tabela lendo dado para cliente anônimo.

**Pendente na Fase 1:** `npm run test:rls` (isolamento entre duas famílias fictícias) continua sem
rodar — exige um segundo projeto Supabase descartável, que ainda não existe. A RLS básica (anônimo
não lê nada) está confirmada; o cenário específico de uma família ver dado de outra não.

### Fase 5 — o que foi construído e o que falta verificar

- `src/server/embeddings/` — interface `EmbeddingProvider` + implementação Voyage AI
  (`voyage-3.5-lite`, 1024 dimensões — testado contra a API real, chave válida).
- `src/server/agents/memory/` — `recallMemories` (busca antes do roteamento) e
  `persistMemoryCandidates` (grava depois da resposta, via `after()`, com deduplicação por
  similaridade ≥ 0.92 — ver `docs/architecture.md` §3.3).
- Grafo (`orchestrator/graph.ts`) e rota de chat já ligados: toda conversa agora passa por recall
  real, e todo `memoryCandidate` emitido pelos agentes é persistido de verdade.
- **O que não foi verificado:** o caminho de ponta a ponta, porque isso exige um usuário logado de
  verdade batendo no `/api/chat`. Login agora é e-mail+senha (sem SMTP no caminho), então isso ficou
  mais simples de testar do que antes — só falta fazer. A chamada direta à API da Voyage foi
  testada e funciona; a integração dela com Supabase + RLS dentro do fluxo de chat, não.

### Retomando depois

1. **Segundo projeto Supabase para `test:rls`** — é de graça, só depende de você criar.
2. **Testar o fluxo de memória de ponta a ponta** — crie uma conta pela tela de login e mande
   algumas mensagens reais no chat para ver `recall`/`persist` acontecendo.
3. **Fase 4 remedida** e **Fase 6** — a última por definição espera meses de dado real.

> **Fora do escopo desta rodada:** `docs/architecture.md` menciona, de passagem, a ideia de trocar o
> resumo de conversa de regra-fixa para LLM "junto com a Fase 5". Isso não foi construído — é uma
> melhoria separada (resumir com modelo, não recuperar memória), ficaria atrás de nova avaliação, e
> ninguém pediu especificamente. O resumo por regra simples (`ruleBasedSummarizer`) continua ativo.

### Revisar o design sem Supabase

`/preview` renderiza o dashboard e o chat com dados fictícios, sem tocar em banco nem em sessão.
Existe só em desenvolvimento (404 em produção — tela com números inventados num app financeiro não
pode escapar para o ambiente real).

```bash
npm run dev   # depois abra http://localhost:3000/preview
```

## Requisitos

- **Node.js 24 LTS.** Não 20. `@supabase/supabase-js` exige `node >= 22`, e a Vercel usa **24.x**
  como padrão para projetos novos — rodar 20 local é divergir de produção. O Node 20 também está
  **deprecado na Vercel a partir de 1º de outubro de 2026**. `package.json` fixa `engines.node`
  em `24.x` para que local e produção não divirjam em silêncio.
- npm 10+
- Uma conta Supabase (plano free serve)

## Setup

```bash
npm install
cp .env.example .env.local
```

Preencha `.env.local`. Nada de chave commitada — `.env*.local` está no `.gitignore`.

### Banco

1. Crie um projeto no Supabase (região `South America (São Paulo)` para a menor latência).
2. Ative a extensão `vector` em Database → Extensions.
3. Cole `supabase/migrations/0001_init.sql` inteiro no SQL Editor e rode.
4. Project Settings → API: copie `URL`, `anon key` e `service_role key` para `.env.local`.
5. Confirme que deu certo:

```bash
npm run db:check
```

`db:check` verifica conectividade, as 16 tabelas, o seed de categorias, o pgvector com a RPC
`match_memories` e — o mais importante — que **um cliente anônimo não lê nada**. A anon key é
pública por desenho; uma tabela sem policy fica aberta para qualquer pessoa.

### Auth: e-mail + senha, uma conta por pessoa

O login trocou de magic link para e-mail + senha. A mudança não foi cosmética — o magic link
depende de três coisas fora do nosso controle acontecerem certas ao mesmo tempo (SMTP configurado,
domínio de redirect cadastrado no Supabase, e-mail chegando a tempo), e qualquer uma errada quebra
o login inteiro com um loop difícil de diagnosticar. Senha resolve a sessão na hora, sem
round-trip de e-mail — cada membro da família cria a própria conta pela aba "Criar conta".

**Obrigatório em Authentication → Providers → Email no Supabase:** desligue **"Confirm email"**.
Sem isso, `signUp()` não devolve sessão ativa até a pessoa clicar num link de confirmação — o
mesmo problema de dependência de e-mail que trocamos de método pra evitar.

Não há fluxo de "esqueci minha senha" implementado de propósito: para 2-4 pessoas, construir uma
tela de recuperação (que reintroduziria e-mail) não compensa. Se alguém esquecer a senha, redefina
manualmente pelo painel do Supabase em Authentication → Users → selecione o usuário → Reset password.

### Segundo projeto, para o teste de RLS

O teste de isolamento cria e destrói usuários — **não aponte para o projeto principal**. Duas
opções:

- **Supabase local** (precisa de Docker): `npx supabase start`, rode a migração e use as
  credenciais que a CLI imprime. Não consome cota e é mais rápido.
- **Segundo projeto na nuvem**: mesmos passos do banco principal. Atenção: o plano free dá
  **2 projetos ativos no total**, contando todas as organizações onde você é owner — principal +
  teste esgota a cota.

Preencha `TEST_SUPABASE_URL`, `TEST_SUPABASE_ANON_KEY` e `TEST_SUPABASE_SERVICE_ROLE_KEY`, e rode:

```bash
npm run test:rls
```

## Keep-alive do Supabase

O plano free do Supabase pausa o projeto após ~7 dias de baixa atividade. `/api/keep-alive` faz um
`select id limit 1` em `households` — sem join, sem contagem — só para gerar uma requisição real que
reinicia o contador. Agendada em `vercel.json` para `0 0 * * *`.

**`CRON_SECRET` precisa estar configurado nas Environment Variables da Vercel** (Production). A
Vercel Cron envia o segredo como `Authorization: Bearer $CRON_SECRET`; sem a variável, a rota
responde 500 em vez de ficar aberta. Gere com `openssl rand -hex 32` e evite quebra de linha ou
caractere de controle, que o header de autorização não aceita.

A rota usa a chave **anon**, não a service role: ela não precisa ler dado nenhum, só que a requisição
chegue ao Postgres. A RLS devolve zero linhas e está correto — o que conta é o round-trip. Um
endpoint alcançável pela internet não deve carregar service role sem necessidade.

Teste local:

```bash
curl -i -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/keep-alive
```

## Comandos

```bash
npm run dev        # servidor de desenvolvimento
npm run build      # build de produção
npm run typecheck  # tsc --noEmit
npm run lint       # eslint
npm test           # testes unitários — rápidos, sem rede, sem LLM (CI)
npm run test:rls   # isolamento de RLS — precisa de Supabase alcançável
npm run eval       # golden set de roteamento — CHAMA MODELO, custa dinheiro
npm run db:check   # smoke test do setup do Supabase
```

`npm test` é o único que roda sem credencial e sem custo. É o que entra no CI.

O `eval` precisa de `ANTHROPIC_API_KEY`, mas **não** de Supabase: `buildPlan` foi separado da busca
de contexto justamente para que validar uma mudança de prompt não exija infraestrutura de pé.

> **Toda alteração em `src/server/agents/orchestrator/prompts.ts` exige rodar `npm run eval`.**
> A acurácia do golden set não pode cair — é o único jeito de saber se um ajuste de redação melhorou
> ou piorou o roteamento.

`npm run eval` roda duas suítes:

| Suíte | O que mede | Limiar |
|---|---|---|
| `tests/eval/routing` | 54 frases → intenção e agente corretos | 90% (medido: 98,1%) |
| `tests/eval/extraction` | 32 frases → valor, data e categoria como chegariam ao banco | valor 98%, data 95%, categoria 85%, os três 85% |

> **Cuidado com o custo.** Cada rodada de roteamento são 54 chamadas ao Sonnet 5 com prompt de
> sistema longo. Iterar no prompt rodando a suíte inteira a cada ajuste esgota crédito rápido —
> durante o desenvolvimento, rode um subconjunto (`-t` do vitest) e deixe a suíte completa para
> confirmar o resultado final.

A avaliação de extração mede o resultado **depois** dos conversores (`parseBRLToCents`,
`resolveDateExpression`, `reconcileCategory`), não o JSON cru do modelo. Medir a saída do LLM daria
uma taxa bonita e irrelevante — o que corrompe dado é o valor final gravado.

## Estrutura

```
src/
  app/                    rotas (App Router). Server Components por padrão.
  server/                 tudo aqui importa `server-only` — quebra o build se
    agents/               vazar para o cliente.
      shared/contracts.ts contratos tipados entre agentes
      orchestrator/       grafo do LangGraph, router, síntese
      bills/ transactions/ tasks/ insights/ memory/
    db/                   clientes Supabase e queries
    llm/                  seleção de modelo por agente, chamadas
    embeddings/           provider de embedding atrás de interface
  lib/                    utilidades client-safe (dinheiro, datas, formatação)
  components/             UI
  styles/globals.css      tokens de design — fonte única da verdade
supabase/migrations/      SQL versionado
docs/                     arquitetura e design
tests/
  unit/                   determinístico, sem rede
  rls/                    isolamento entre households
  eval/                   golden sets que chamam modelo
```

## Regras que não se quebram

1. Dinheiro é sempre inteiro em centavos. Nunca float, nunca `numeric` lido como número.
2. Nada que toque service role ou o modelo roda em client component.
3. `agent_runs` guarda metadado apenas — nunca valor, título de conta ou conteúdo de mensagem.
4. Agente que falha produz resposta parcial honesta, nunca resposta inventada.
5. Apagar memória ou dado é `DELETE` de verdade, não flag na UI.
