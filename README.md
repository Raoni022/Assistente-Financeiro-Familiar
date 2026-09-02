# Assistente Financeiro Familiar

Sistema multi-agente de assistência financeira para uso da família. Next.js + Supabase + LangGraph.

- **Arquitetura, grafo de agentes, contratos e modelo de dados:** [`docs/architecture.md`](docs/architecture.md)
- **Sistema de design, paleta, tipografia e wireframes:** [`docs/design.md`](docs/design.md)

## Estado atual

| Fase | Escopo | Status |
|---|---|---|
| 1 | Fundação: setup, schema + RLS, estrutura de pastas, plano de design, shell visual | **em andamento** |
| 2 | Orquestrador + Agente de Contas | não iniciada |
| 3 | Agente de Gastos + avaliação de extração | não iniciada |
| 4 | Agente de Tarefas | não iniciada |
| 5 | Memória semântica (pgvector) | não iniciada |
| 6 | Insights | não iniciada |

Concluído na Fase 1: dependências, TypeScript estrito, Tailwind v4, tokens de design,
contratos de agente, migração de schema com RLS, harness de testes.
Pendente na Fase 1: aplicar a migração num Supabase real, teste de isolamento de RLS,
auth, shell visual.

## Requisitos

- **Node.js 22 LTS.** Não 20. `@supabase/supabase-js@2.114` declara `engines: node >= 22`, e a
  Vercel roda Node 22 por padrão — rodar 20 localmente é divergir do ambiente de produção.
- npm 10+
- Uma conta Supabase (plano free serve)

## Setup

```bash
npm install
cp .env.example .env.local
```

Preencha `.env.local`. Nada de chave commitada — `.env*.local` está no `.gitignore`.

### Banco

1. Crie um projeto no Supabase.
2. Ative a extensão `vector` (Database → Extensions → `vector`).
3. Rode `supabase/migrations/0001_init.sql` no SQL Editor.
4. Copie `URL`, `anon key` e `service_role key` para `.env.local`.

Para o teste de isolamento de RLS, crie um **segundo projeto descartável** e preencha as variáveis
`TEST_SUPABASE_*`. O teste cria e destrói dois households fictícios — não aponte para produção.

## Comandos

```bash
npm run dev        # servidor de desenvolvimento
npm run build      # build de produção
npm run typecheck  # tsc --noEmit
npm run lint       # eslint
npm test           # testes unitários — rápidos, sem rede, sem LLM (CI)
npm run test:rls   # isolamento de RLS — precisa de Supabase alcançável
npm run eval       # avaliação de roteamento e extração — CHAMA MODELO, custa dinheiro
```

`npm test` é o único que roda sem credencial e sem custo. É o que entra no CI.

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
