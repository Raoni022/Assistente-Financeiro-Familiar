-- =============================================================================
-- 0001_init.sql — schema inicial
-- Ver docs/architecture.md §4 para o racional de cada decisão.
--
-- Convenções:
--   * Dinheiro é SEMPRE bigint em centavos. Nunca float, nunca numeric.
--   * Datas de negócio são `date`. Carimbos de tempo são `timestamptz`.
--   * Estado derivável NÃO é armazenado (ex: "em atraso" vem de due_date + status).
--   * Toda tabela com household_id tem RLS ligado e policy escopada.
-- =============================================================================

create extension if not exists vector;

-- =============================================================================
-- ENUMS
-- =============================================================================

create type household_role      as enum ('admin', 'member');
create type bill_recurrence     as enum ('none', 'weekly', 'monthly', 'quarterly', 'yearly');
-- Sem 'overdue': atraso é derivado (status = 'pending' and due_date < today).
-- Guardar atraso como estado convida a drift entre o banco e a realidade.
create type occurrence_status   as enum ('pending', 'paid', 'cancelled');
create type transaction_kind    as enum ('expense', 'income');
create type transaction_source  as enum ('manual', 'agent', 'import');
create type task_status         as enum ('todo', 'doing', 'done', 'cancelled');
create type memory_scope        as enum ('user', 'household');
create type memory_kind         as enum ('preference', 'fact', 'decision', 'pattern');
create type memory_source       as enum ('chat', 'correction', 'derived');
create type message_role        as enum ('user', 'assistant');
create type agent_run_status    as enum ('success', 'error', 'timeout', 'skipped');
create type notification_channel as enum ('in_app', 'email', 'push');

-- =============================================================================
-- HOUSEHOLDS E PESSOAS
-- =============================================================================

create table households (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(trim(name)) between 1 and 80),
  timezone    text not null default 'America/Sao_Paulo',
  -- Orçamento mensal previsto, em centavos. Null = ainda não definido.
  monthly_budget_cents bigint check (monthly_budget_cents is null or monthly_budget_cents > 0),
  created_at  timestamptz not null default now()
);

-- `profiles`, não `users`: public.users convivendo com auth.users é fonte
-- garantida de confusão em policy e em join.
create table profiles (
  id            uuid primary key references auth.users (id) on delete cascade,
  household_id  uuid references households (id) on delete set null,
  display_name  text not null check (length(trim(display_name)) between 1 and 60),
  role          household_role not null default 'member',
  created_at    timestamptz not null default now()
);

create index profiles_household_idx on profiles (household_id);

-- Convite por código curto. 2-4 pessoas, sem fluxo de e-mail (decisão: só in-app).
create table household_invites (
  code         text primary key check (code ~ '^[A-Z0-9]{8}$'),
  household_id uuid not null references households (id) on delete cascade,
  created_by   uuid not null references profiles (id) on delete cascade,
  expires_at   timestamptz not null,
  used_by      uuid references profiles (id) on delete set null,
  used_at      timestamptz,
  created_at   timestamptz not null default now()
);

create index household_invites_household_idx on household_invites (household_id);

-- =============================================================================
-- ESCOPO: a função que toda policy usa
-- =============================================================================

-- SECURITY DEFINER é obrigatório: sem ele, a policy de `profiles` consultaria
-- `profiles` e entraria em recursão infinita.
-- Retorna NULL para usuário sem household → toda policy nega. Default seguro.
create or replace function public.current_household_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select household_id from public.profiles where id = auth.uid()
$$;

create or replace function public.is_household_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select role = 'admin' from public.profiles where id = auth.uid()), false)
$$;

revoke execute on function public.current_household_id() from public;
revoke execute on function public.is_household_admin() from public;
grant execute on function public.current_household_id() to authenticated;
grant execute on function public.is_household_admin() to authenticated;

-- =============================================================================
-- CATEGORIAS
-- household_id NULL = categoria global, visível a todos. Custom sobrescreve.
-- =============================================================================

create table categories (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid references households (id) on delete cascade,
  key          text not null check (key ~ '^[a-z0-9_]{2,32}$'),
  label        text not null,
  is_bill      boolean not null default false,
  created_at   timestamptz not null default now()
);

-- Uma chave é única dentro do household; e única entre as globais.
create unique index categories_household_key_idx
  on categories (household_id, key) where household_id is not null;
create unique index categories_global_key_idx
  on categories (key) where household_id is null;

insert into categories (household_id, key, label, is_bill) values
  (null, 'mercado',      'Mercado',        false),
  (null, 'delivery',     'Delivery',       false),
  (null, 'restaurante',  'Restaurante',    false),
  (null, 'transporte',   'Transporte',     false),
  (null, 'combustivel',  'Combustível',    false),
  (null, 'saude',        'Saúde',          false),
  (null, 'farmacia',     'Farmácia',       false),
  (null, 'educacao',     'Educação',       true),
  (null, 'lazer',        'Lazer',          false),
  (null, 'vestuario',    'Vestuário',      false),
  (null, 'casa',         'Casa',           false),
  (null, 'pet',          'Pet',            false),
  (null, 'assinatura',   'Assinatura',     true),
  (null, 'energia',      'Energia',        true),
  (null, 'agua',         'Água',           true),
  (null, 'internet',     'Internet',       true),
  (null, 'telefone',     'Telefone',       true),
  (null, 'aluguel',      'Aluguel',        true),
  (null, 'condominio',   'Condomínio',     true),
  (null, 'cartao',       'Cartão de crédito', true),
  (null, 'emprestimo',   'Empréstimo',     true),
  (null, 'imposto',      'Imposto',        true),
  (null, 'seguro',       'Seguro',         true),
  (null, 'salario',      'Salário',        false),
  (null, 'outros',       'Outros',         false);

-- =============================================================================
-- CONTAS A PAGAR
-- `bills` = definição. `bill_occurrences` = cada vencimento, com status próprio.
-- Conta avulsa = definição com exatamente uma ocorrência.
-- O dashboard SEMPRE lê bill_occurrences — consulta uniforme, histórico real.
-- =============================================================================

create table bills (
  id             uuid primary key default gen_random_uuid(),
  household_id   uuid not null references households (id) on delete cascade,
  title          text not null check (length(trim(title)) between 1 and 120),
  amount_cents   bigint not null check (amount_cents > 0),
  category_id    uuid references categories (id) on delete set null,
  recurrence     bill_recurrence not null default 'none',
  -- Dia do mês (1-31) para recorrência mensal/trimestral/anual.
  recurrence_day smallint check (recurrence_day between 1 and 31),
  -- Data da primeira (ou única) ocorrência.
  starts_on      date not null,
  -- Null = sem fim previsto.
  ends_on        date,
  responsible_id uuid references profiles (id) on delete set null,
  created_by     uuid not null references profiles (id) on delete restrict,
  reminder_days_before smallint not null default 3 check (reminder_days_before between 0 and 30),
  is_active      boolean not null default true,
  notes          text check (notes is null or length(notes) <= 1000),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  constraint bills_recurrence_day_required
    check (recurrence = 'none' or recurrence = 'weekly' or recurrence_day is not null),
  constraint bills_ends_after_starts
    check (ends_on is null or ends_on >= starts_on)
);

create table bill_occurrences (
  id           uuid primary key default gen_random_uuid(),
  bill_id      uuid not null references bills (id) on delete cascade,
  -- Desnormalizado de propósito: sem isso, toda policy e todo índice do
  -- dashboard precisariam de join com bills.
  household_id uuid not null references households (id) on delete cascade,
  due_date     date not null,
  -- Pode divergir de bills.amount_cents: a conta de luz varia todo mês.
  amount_cents bigint not null check (amount_cents > 0),
  status       occurrence_status not null default 'pending',
  paid_at      timestamptz,
  paid_by      uuid references profiles (id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  constraint occurrence_paid_consistency
    check ((status = 'paid') = (paid_at is not null))
);

-- Impede geração duplicada de ocorrência para o mesmo vencimento.
create unique index bill_occurrences_bill_due_idx on bill_occurrences (bill_id, due_date);
-- Agenda do dashboard.
create index bill_occurrences_household_due_idx on bill_occurrences (household_id, due_date);
-- Parcial: "o que vence" e detecção de atraso tocam só as pendentes.
create index bill_occurrences_pending_idx
  on bill_occurrences (household_id, due_date) where status = 'pending';

create index bills_household_active_idx on bills (household_id) where is_active;

-- =============================================================================
-- TRANSAÇÕES
-- =============================================================================

create table transactions (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references households (id) on delete cascade,
  kind          transaction_kind not null default 'expense',
  amount_cents  bigint not null check (amount_cents > 0),
  category_id   uuid references categories (id) on delete set null,
  occurred_on   date not null,
  description   text check (description is null or length(description) <= 300),
  -- Quem gastou (pode não ser quem registrou).
  spent_by      uuid references profiles (id) on delete set null,
  created_by    uuid not null references profiles (id) on delete restrict,
  source        transaction_source not null default 'manual',
  -- A frase original em linguagem natural. Alimenta o dataset de avaliação de
  -- extração e permite auditar um registro suspeito. Fica dentro do escopo do
  -- household — nunca vai para log de terceiro.
  raw_input     text check (raw_input is null or length(raw_input) <= 500),
  -- Confiança da extração automática, 0..1. Null quando entrada foi manual.
  extraction_confidence real check (extraction_confidence is null
                                    or extraction_confidence between 0 and 1),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index transactions_household_date_idx  on transactions (household_id, occurred_on desc);
create index transactions_household_cat_idx   on transactions (household_id, category_id, occurred_on);
create index transactions_household_payer_idx on transactions (household_id, spent_by, occurred_on);

-- A correção do usuário é sinal de aprendizado (brief §2.1), não só um UPDATE.
-- É daqui que saem memoryCandidates do tipo 'pattern'.
create table transaction_corrections (
  id             uuid primary key default gen_random_uuid(),
  transaction_id uuid not null references transactions (id) on delete cascade,
  household_id   uuid not null references households (id) on delete cascade,
  field          text not null check (field in ('category_id', 'amount_cents', 'occurred_on', 'spent_by')),
  old_value      text,
  new_value      text,
  corrected_by   uuid not null references profiles (id) on delete cascade,
  created_at     timestamptz not null default now()
);

create index transaction_corrections_household_idx
  on transaction_corrections (household_id, created_at desc);

-- =============================================================================
-- TAREFAS
-- =============================================================================

create table tasks (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references households (id) on delete cascade,
  title        text not null check (length(trim(title)) between 1 and 160),
  description  text check (description is null or length(description) <= 2000),
  due_date     date,
  status       task_status not null default 'todo',
  assignee_id  uuid references profiles (id) on delete set null,
  bill_id      uuid references bills (id) on delete set null,
  created_by   uuid not null references profiles (id) on delete restrict,
  completed_at timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  constraint tasks_done_consistency
    check ((status = 'done') = (completed_at is not null))
);

create index tasks_household_status_idx on tasks (household_id, status, due_date);

-- =============================================================================
-- MEMÓRIA SEMÂNTICA
-- Dimensão 1024 = voyage-3.5-lite. Trocar de provider exige nova migração.
-- =============================================================================

create table memories (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references households (id) on delete cascade,
  scope        memory_scope not null,
  -- Obrigatório quando scope = 'user'; ignorado quando 'household'.
  owner_id     uuid references profiles (id) on delete cascade,
  kind         memory_kind not null,
  content      text not null check (length(trim(content)) between 1 and 1000),
  embedding    vector(1024) not null,
  source       memory_source not null,
  -- Referência frouxa à origem (message_id, transaction_id...). Sem FK: a
  -- memória sobrevive ao apagamento da origem.
  source_ref   uuid,
  confidence   real not null default 1 check (confidence between 0 and 1),
  last_used_at timestamptz,
  -- Null = não expira. Usado para memórias sazonais ("está economizando p/ viagem em dez").
  expires_at   timestamptz,
  created_at   timestamptz not null default now(),

  constraint memories_owner_required
    check ((scope = 'user') = (owner_id is not null))
);

create index memories_scope_idx on memories (household_id, scope, owner_id);
-- HNSW e não IVFFlat: recall melhor e não exige treino sobre dados já existentes,
-- o que importa aqui porque a tabela começa vazia.
create index memories_embedding_idx on memories
  using hnsw (embedding vector_cosine_ops) with (m = 16, ef_construction = 64);

-- SECURITY INVOKER (default): a busca vetorial respeita RLS. Não trocar.
create or replace function public.match_memories(
  query_embedding vector(1024),
  match_count     int default 8,
  min_similarity  real default 0.7
)
returns table (id uuid, content text, kind memory_kind, scope memory_scope, similarity real)
language sql
stable
set search_path = public
as $$
  select m.id,
         m.content,
         m.kind,
         m.scope,
         (1 - (m.embedding <=> query_embedding))::real as similarity
    from public.memories m
   -- Predicado explícito além da RLS: defesa em profundidade. Se algum dia esta
   -- função for chamada com service role (que ignora RLS), ela falha fechada —
   -- current_household_id() é NULL e o resultado vem vazio, em vez de vazar tudo.
   where m.household_id = public.current_household_id()
     and (m.scope = 'household' or m.owner_id = auth.uid())
     and (m.expires_at is null or m.expires_at > now())
     and (1 - (m.embedding <=> query_embedding)) >= min_similarity
   order by m.embedding <=> query_embedding
   limit greatest(1, least(match_count, 50))
$$;

-- =============================================================================
-- CONVERSAS
-- =============================================================================

create table conversations (
  id                 uuid primary key default gen_random_uuid(),
  household_id       uuid not null references households (id) on delete cascade,
  user_id            uuid not null references profiles (id) on delete cascade,
  title              text,
  -- Resumo rolante. Fase 2: gerado por regra. Fase 5: por LLM.
  summary            text,
  summary_updated_at timestamptz,
  -- Quantas mensagens já entraram no resumo — evita re-resumir tudo.
  summarized_through int not null default 0,
  last_message_at    timestamptz not null default now(),
  created_at         timestamptz not null default now()
);

create index conversations_user_idx on conversations (user_id, last_message_at desc);

create table messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations (id) on delete cascade,
  household_id    uuid not null references households (id) on delete cascade,
  role            message_role not null,
  content         text not null,
  -- UiBlocks renderizados inline no chat (cards, mini-gráficos).
  blocks          jsonb,
  created_at      timestamptz not null default now()
);

create index messages_conversation_idx on messages (conversation_id, created_at desc);

-- =============================================================================
-- OBSERVABILIDADE
-- ATENÇÃO: esta tabela NÃO recebe valor, título de conta, descrição de gasto
-- nem conteúdo de mensagem. Somente metadado. Ver docs/architecture.md §5.
-- =============================================================================

create table agent_runs (
  id              uuid primary key default gen_random_uuid(),
  household_id    uuid not null references households (id) on delete cascade,
  -- Correlaciona todos os passos de uma mesma mensagem do usuário.
  trace_id        uuid not null,
  conversation_id uuid references conversations (id) on delete set null,
  agent           text not null,
  intent          text not null,
  status          agent_run_status not null,
  duration_ms     int not null check (duration_ms >= 0),
  error_code      text,
  model           text,
  input_tokens    int,
  output_tokens   int,
  retried         boolean not null default false,
  created_at      timestamptz not null default now()
);

create index agent_runs_household_idx on agent_runs (household_id, created_at desc);
create index agent_runs_agent_idx     on agent_runs (agent, status, created_at desc);
create index agent_runs_trace_idx     on agent_runs (trace_id);

-- =============================================================================
-- NOTIFICAÇÕES (só canal in_app implementado; schema já aceita os outros)
-- =============================================================================

create table notifications (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references households (id) on delete cascade,
  user_id      uuid not null references profiles (id) on delete cascade,
  channel      notification_channel not null default 'in_app',
  kind         text not null,
  title        text not null,
  body         text,
  ref_table    text,
  ref_id       uuid,
  read_at      timestamptz,
  created_at   timestamptz not null default now()
);

create index notifications_user_unread_idx
  on notifications (user_id, created_at desc) where read_at is null;

create table notification_preferences (
  user_id              uuid primary key references profiles (id) on delete cascade,
  reminder_days_before smallint not null default 3 check (reminder_days_before between 0 and 30),
  channels             notification_channel[] not null default array['in_app']::notification_channel[],
  updated_at           timestamptz not null default now()
);

-- =============================================================================
-- RATE LIMIT (em Postgres — volume é familiar, um Redis a mais é superfície
-- sem ganho. Ver docs/architecture.md §5.)
-- =============================================================================

create table rate_limits (
  subject_id   uuid not null,
  bucket       text not null,
  window_start timestamptz not null,
  count        int not null default 0,
  primary key (subject_id, bucket, window_start)
);

create index rate_limits_gc_idx on rate_limits (window_start);

-- =============================================================================
-- updated_at automático
-- =============================================================================

create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end
$$;

create trigger bills_touch            before update on bills            for each row execute function public.touch_updated_at();
create trigger bill_occurrences_touch before update on bill_occurrences for each row execute function public.touch_updated_at();
create trigger transactions_touch     before update on transactions     for each row execute function public.touch_updated_at();
create trigger tasks_touch            before update on tasks            for each row execute function public.touch_updated_at();

-- =============================================================================
-- ROW LEVEL SECURITY
-- Testado em tests/rls/isolation.test.ts com dois households fictícios.
-- =============================================================================

alter table households               enable row level security;
alter table profiles                 enable row level security;
alter table household_invites        enable row level security;
alter table categories               enable row level security;
alter table bills                    enable row level security;
alter table bill_occurrences         enable row level security;
alter table transactions             enable row level security;
alter table transaction_corrections  enable row level security;
alter table tasks                    enable row level security;
alter table memories                 enable row level security;
alter table conversations            enable row level security;
alter table messages                 enable row level security;
alter table agent_runs               enable row level security;
alter table notifications            enable row level security;
alter table notification_preferences enable row level security;
alter table rate_limits              enable row level security;

-- rate_limits: nenhuma policy. Só o service role toca — negado a todos por padrão.

create policy households_select on households for select to authenticated
  using (id = public.current_household_id());
create policy households_update on households for update to authenticated
  using (id = public.current_household_id() and public.is_household_admin())
  with check (id = public.current_household_id());

create policy profiles_select on profiles for select to authenticated
  using (id = auth.uid() or household_id = public.current_household_id());
create policy profiles_update_self on profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

create policy invites_select on household_invites for select to authenticated
  using (household_id = public.current_household_id());
create policy invites_insert on household_invites for insert to authenticated
  with check (household_id = public.current_household_id() and public.is_household_admin());
create policy invites_delete on household_invites for delete to authenticated
  using (household_id = public.current_household_id() and public.is_household_admin());

-- Categorias globais são legíveis por todos; custom só do household.
create policy categories_select on categories for select to authenticated
  using (household_id is null or household_id = public.current_household_id());
create policy categories_write on categories for all to authenticated
  using (household_id = public.current_household_id())
  with check (household_id = public.current_household_id());

-- Padrão household-scoped, aplicado a todas as tabelas de dado financeiro.
create policy bills_rw on bills for all to authenticated
  using (household_id = public.current_household_id())
  with check (household_id = public.current_household_id());

create policy bill_occurrences_rw on bill_occurrences for all to authenticated
  using (household_id = public.current_household_id())
  with check (household_id = public.current_household_id());

create policy transactions_rw on transactions for all to authenticated
  using (household_id = public.current_household_id())
  with check (household_id = public.current_household_id());

create policy transaction_corrections_rw on transaction_corrections for all to authenticated
  using (household_id = public.current_household_id())
  with check (household_id = public.current_household_id());

create policy tasks_rw on tasks for all to authenticated
  using (household_id = public.current_household_id())
  with check (household_id = public.current_household_id());

-- Memória de escopo 'user' só é visível ao dono, mesmo dentro do household.
create policy memories_rw on memories for all to authenticated
  using (
    household_id = public.current_household_id()
    and (scope = 'household' or owner_id = auth.uid())
  )
  with check (
    household_id = public.current_household_id()
    and (scope = 'household' or owner_id = auth.uid())
  );

-- Conversa é privada por pessoa, mesmo entre membros da casa.
create policy conversations_rw on conversations for all to authenticated
  using (user_id = auth.uid() and household_id = public.current_household_id())
  with check (user_id = auth.uid() and household_id = public.current_household_id());

create policy messages_rw on messages for all to authenticated
  using (
    household_id = public.current_household_id()
    and exists (
      select 1 from conversations c
       where c.id = messages.conversation_id and c.user_id = auth.uid()
    )
  )
  with check (
    household_id = public.current_household_id()
    and exists (
      select 1 from conversations c
       where c.id = messages.conversation_id and c.user_id = auth.uid()
    )
  );

-- agent_runs: leitura para depuração; escrita só pelo servidor (service role).
create policy agent_runs_select on agent_runs for select to authenticated
  using (household_id = public.current_household_id());

create policy notifications_select on notifications for select to authenticated
  using (user_id = auth.uid());
create policy notifications_update on notifications for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy notifications_delete on notifications for delete to authenticated
  using (user_id = auth.uid());

create policy notification_prefs_rw on notification_preferences for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
