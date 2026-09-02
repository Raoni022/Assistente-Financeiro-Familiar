# Assistente Financeiro Familiar

Sistema multi-agente de assistência financeira para uso da família. Next.js + Supabase + LangGraph.

- **Arquitetura, grafo de agentes, contratos e modelo de dados:** [`docs/architecture.md`](docs/architecture.md)
- **Sistema de design, paleta, tipografia e wireframes:** [`docs/design.md`](docs/design.md)

## Estado atual

| Fase | Escopo | Status |
|---|---|---|
| 1 | Fundação: setup, schema + RLS, auth, estrutura de pastas, plano de design, shell visual | **código pronto — falta validar contra um Supabase real** |
| 2 | Orquestrador + Agente de Contas | **código pronto — falta validar com banco e chave da Anthropic** |
| 3 | Agente de Gastos + avaliação de extração | **código pronto — falta rodar a avaliação** |
| 4 | Agente de Tarefas | **código pronto — falta validar com banco e chave** |
| 5 | Memória semântica (pgvector) | não iniciada |
| 6 | Insights | não iniciada |

**Concluído na Fase 1:** dependências, TypeScript estrito, Tailwind v4, tokens de design, contratos
de agente, migração de schema com RLS, auth por magic link, onboarding (criar casa / entrar por
convite), shell visual completo (dashboard + chat flutuante) e a suíte de isolamento de RLS escrita.

**Pendente na Fase 1, e depende de você:** aplicar a migração num Supabase real e rodar
`npm run test:rls`. Até isso acontecer, o schema e as policies são código não verificado — o
requisito 5.1 do brief pede isolamento *testado*, não presumido.

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

### Auth (obrigatório para o magic link funcionar)

Em Authentication → URL Configuration:

- **Site URL**: `http://localhost:3000` em desenvolvimento, o domínio da Vercel em produção.
- **Redirect URLs**: adicione `http://localhost:3000/auth/callback` e
  `https://SEU-DOMINIO.vercel.app/auth/callback`.

Sem isso o link chega no e-mail e o retorno falha.

> **⚠️ O SMTP embutido do Supabase só entrega para endereços que estão no time do projeto**, com
> limite baixo de mensagens por hora. Ou seja: o magic link chega para você, mas **não chega para
> os outros membros da família**. Antes de convidar alguém, configure um SMTP próprio em
> Authentication → Emails → SMTP Settings. O free do Resend resolve.

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
| `tests/eval/routing` | 54 frases → intenção e agente corretos | 90% |
| `tests/eval/extraction` | 32 frases → valor, data e categoria como chegariam ao banco | valor 98%, data 95%, categoria 85%, os três 85% |

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
