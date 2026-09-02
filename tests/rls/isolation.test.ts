import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import 'dotenv/config';

/**
 * Isolamento entre households — requisito 5.1 do brief: "testado com pelo menos
 * dois households fictícios para garantir isolamento real, não só assumir que
 * funciona".
 *
 * Aponte TEST_SUPABASE_* para um projeto DESCARTÁVEL. O teste cria e destrói
 * usuários e dados. Nunca aponte para produção.
 *
 * `npm run test:rls`
 */

const url = process.env['TEST_SUPABASE_URL'];
const anonKey = process.env['TEST_SUPABASE_ANON_KEY'];
const serviceKey = process.env['TEST_SUPABASE_SERVICE_ROLE_KEY'];
const configured = Boolean(url && anonKey && serviceKey);

/** Embedding sintético: só precisa ter a dimensão certa e ser determinístico. */
function fakeEmbedding(seed: number): number[] {
  return Array.from({ length: 1024 }, (_, i) => Math.sin((i + 1) * seed) / 2);
}

interface Fixture {
  householdId: string;
  userId: string;
  client: SupabaseClient;
  billOccurrenceId: string;
  transactionId: string;
}

describe.skipIf(!configured)('isolamento de RLS entre households', () => {
  // O corpo de um `describe.skipIf` ainda é avaliado — instanciar o cliente
  // aqui com URL indefinida quebraria a coleta antes de qualquer skip.
  const admin = configured
    ? createClient(url!, serviceKey!, { auth: { autoRefreshToken: false, persistSession: false } })
    : (null as unknown as SupabaseClient);

  const stamp = Date.now();
  let casaA: Fixture;
  let casaB: Fixture;

  async function signIn(email: string, password: string): Promise<SupabaseClient> {
    const client = createClient(url!, anonKey!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { error } = await client.auth.signInWithPassword({ email, password });
    if (error) throw error;
    return client;
  }

  async function seed(label: string, seedNumber: number): Promise<Fixture> {
    const email = `rls-${label}-${stamp}@example.test`;
    const password = `Teste!${stamp}${label}`;

    const { data: household, error: householdError } = await admin
      .from('households')
      .insert({ name: `Casa ${label} ${stamp}` })
      .select('id')
      .single();
    if (householdError) throw householdError;

    const { data: created, error: userError } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (userError) throw userError;
    const userId = created.user.id;

    const { error: profileError } = await admin.from('profiles').insert({
      id: userId,
      household_id: household.id,
      display_name: `Pessoa ${label}`,
      role: 'admin',
    });
    if (profileError) throw profileError;

    const { data: bill, error: billError } = await admin
      .from('bills')
      .insert({
        household_id: household.id,
        title: `Energia ${label}`,
        amount_cents: 34000,
        starts_on: '2026-09-15',
        created_by: userId,
      })
      .select('id')
      .single();
    if (billError) throw billError;

    const { data: occurrence, error: occurrenceError } = await admin
      .from('bill_occurrences')
      .insert({
        bill_id: bill.id,
        household_id: household.id,
        due_date: '2026-09-15',
        amount_cents: 34000,
      })
      .select('id')
      .single();
    if (occurrenceError) throw occurrenceError;

    const { data: transaction, error: transactionError } = await admin
      .from('transactions')
      .insert({
        household_id: household.id,
        amount_cents: 8000,
        occurred_on: '2026-09-02',
        description: `Mercado ${label}`,
        created_by: userId,
      })
      .select('id')
      .single();
    if (transactionError) throw transactionError;

    const { error: memoryError } = await admin.from('memories').insert({
      household_id: household.id,
      scope: 'household',
      kind: 'decision',
      content: `Segredo da casa ${label}`,
      embedding: fakeEmbedding(seedNumber),
      source: 'chat',
    });
    if (memoryError) throw memoryError;

    return {
      householdId: household.id,
      userId,
      client: await signIn(email, password),
      billOccurrenceId: occurrence.id,
      transactionId: transaction.id,
    };
  }

  beforeAll(async () => {
    casaA = await seed('A', 1);
    casaB = await seed('B', 2);
  }, 60_000);

  afterAll(async () => {
    for (const fixture of [casaA, casaB]) {
      if (!fixture) continue;
      await admin.auth.admin.deleteUser(fixture.userId).catch(() => {});
      // Cascata apaga bills, ocorrências, transações e memórias.
      await admin.from('households').delete().eq('id', fixture.householdId);
    }
  }, 60_000);

  it('cada casa enxerga apenas as próprias contas', async () => {
    const { data } = await casaA.client.from('bill_occurrences').select('id, household_id');
    expect(data).toHaveLength(1);
    expect(data![0]!['household_id']).toBe(casaA.householdId);
    expect(data!.map((row) => row['id'])).not.toContain(casaB.billOccurrenceId);
  });

  it('cada casa enxerga apenas os próprios gastos', async () => {
    const { data } = await casaB.client.from('transactions').select('id, household_id');
    expect(data).toHaveLength(1);
    expect(data![0]!['household_id']).toBe(casaB.householdId);
  });

  it('leitura direta por id de outra casa retorna vazio, não erro silencioso', async () => {
    const { data, error } = await casaA.client
      .from('transactions')
      .select('id')
      .eq('id', casaB.transactionId);
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it('não permite gravar dado em outra casa', async () => {
    const { error } = await casaA.client.from('transactions').insert({
      household_id: casaB.householdId,
      amount_cents: 1,
      occurred_on: '2026-09-02',
      created_by: casaA.userId,
    });
    // WITH CHECK da policy rejeita: violação de RLS.
    expect(error).not.toBeNull();
    expect(error!.code).toBe('42501');
  });

  it('não permite mover um registro próprio para outra casa via UPDATE', async () => {
    const { data } = await casaA.client
      .from('transactions')
      .update({ household_id: casaB.householdId })
      .eq('id', casaA.transactionId)
      .select('id');
    // Nenhuma linha satisfaz o WITH CHECK — nada é movido.
    expect(data ?? []).toEqual([]);

    const { data: still } = await admin
      .from('transactions')
      .select('household_id')
      .eq('id', casaA.transactionId)
      .single();
    expect(still!['household_id']).toBe(casaA.householdId);
  });

  it('não permite apagar dado de outra casa', async () => {
    await casaA.client.from('bill_occurrences').delete().eq('id', casaB.billOccurrenceId);

    const { data } = await admin
      .from('bill_occurrences')
      .select('id')
      .eq('id', casaB.billOccurrenceId);
    expect(data).toHaveLength(1);
  });

  it('busca vetorial não atravessa households', async () => {
    // O embedding da casa B, consultado pela casa A: se a RLS falhasse na RPC,
    // este é exatamente o resultado que voltaria em primeiro lugar.
    const { data, error } = await casaA.client.rpc('match_memories', {
      query_embedding: fakeEmbedding(2),
      match_count: 20,
      min_similarity: -1,
    });

    expect(error).toBeNull();
    const contents = ((data ?? []) as Array<{ content: string }>).map((row) => row.content);
    expect(contents).not.toContain('Segredo da casa B');
    expect(contents).toContain('Segredo da casa A');
  });

  it('memória de escopo user não vaza para outro membro da mesma casa', async () => {
    const email = `rls-A2-${stamp}@example.test`;
    const password = `Teste!${stamp}A2`;

    const { data: outro, error: userError } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (userError) throw userError;

    try {
      await admin.from('profiles').insert({
        id: outro.user.id,
        household_id: casaA.householdId,
        display_name: 'Pessoa A2',
        role: 'member',
      });

      await admin.from('memories').insert({
        household_id: casaA.householdId,
        scope: 'user',
        owner_id: casaA.userId,
        kind: 'preference',
        content: 'Preferência privada de A',
        embedding: fakeEmbedding(3),
        source: 'chat',
      });

      const client = await signIn(email, password);
      const { data } = await client.from('memories').select('content');
      const contents = (data ?? []).map((row) => row['content']);

      // Mesma casa: vê a memória de household...
      expect(contents).toContain('Segredo da casa A');
      // ...mas não a memória pessoal do outro membro.
      expect(contents).not.toContain('Preferência privada de A');
    } finally {
      await admin.auth.admin.deleteUser(outro.user.id).catch(() => {});
    }
  }, 30_000);

  it('usuário sem household não enxerga nada', async () => {
    const email = `rls-orfao-${stamp}@example.test`;
    const password = `Teste!${stamp}orfao`;

    const { data: created, error } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (error) throw error;

    try {
      // Sem profile, current_household_id() é NULL e toda policy nega.
      const client = await signIn(email, password);

      for (const table of ['bill_occurrences', 'transactions', 'memories', 'tasks'] as const) {
        const { data } = await client.from(table).select('id');
        expect(data ?? []).toEqual([]);
      }
    } finally {
      await admin.auth.admin.deleteUser(created.user.id).catch(() => {});
    }
  }, 30_000);
});

describe.skipIf(configured)('isolamento de RLS', () => {
  it('pulado: defina TEST_SUPABASE_URL, TEST_SUPABASE_ANON_KEY e TEST_SUPABASE_SERVICE_ROLE_KEY', () => {
    expect(configured).toBe(false);
  });
});
