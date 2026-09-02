# Assistente Financeiro Familiar

Sistema multi-agente de assistência financeira para uso da família. Next.js + Supabase + LangGraph.

- **Arquitetura, grafo de agentes, contratos e modelo de dados:** [`docs/architecture.md`](docs/architecture.md)
- **Sistema de design, paleta, tipografia e wireframes:** [`docs/design.md`](docs/design.md)

## Estado atual

| Fase | Escopo | Status |
|---|---|---|
| 1 | Fundação: setup, schema + RLS, auth, estrutura de pastas, plano de design, shell visual | **código pronto — falta validar contra um Supabase real** |
| 2 | Orquestrador + Agente de Contas | não iniciada |
| 3 | Agente de Gastos + avaliação de extração | não iniciada |
| 4 | Agente de Tarefas | não iniciada |
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
