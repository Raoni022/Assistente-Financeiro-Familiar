import 'server-only';
import { monthRange, relativeDayLabel, todayInTz, type IsoDate } from '@/lib/dates';
import { formatCents, MoneyParseError, parseBRLToCents, type Cents } from '@/lib/money';
import { createClient } from '@/server/db/server';
import { titleSimilarity } from '@/server/agents/bills/logic';
import type {
  AgentRequest,
  AgentResponse,
  MemoryCandidate,
  UiBlock,
} from '@/server/agents/shared/contracts';
import { aggregateBy, reconcileCategory, resolveDateExpression } from './logic';
import { TRANSACTIONS_PAYLOAD_SCHEMAS, type TransactionsIntent } from './schemas';

/**
 * Agente de Gastos (transações manuais).
 *
 * O registro de gasto é a operação mais frequente do sistema e a mais fácil de
 * corromper em silêncio: uma data errada joga o gasto para outro mês e distorce
 * toda consolidação de período. Por isso valor e data passam por conversores
 * testados, e uma data que o código não entende vira pergunta, não suposição.
 */

type Supabase = Awaited<ReturnType<typeof createClient>>;

interface TransactionRow {
  id: string;
  kind: 'expense' | 'income';
  amount_cents: number;
  occurred_on: string;
  description: string | null;
  category_id: string | null;
  spent_by: string | null;
}

function fail(
  code: 'VALIDATION' | 'NOT_FOUND' | 'AMBIGUOUS' | 'DB',
  message: string,
  userFacing: string,
): AgentResponse {
  return { success: false, error: { code, message, retryable: false }, summaryForOrchestrator: userFacing };
}

function parseAmount(raw: string): Cents | { error: string } {
  try {
    const cents = parseBRLToCents(raw);
    if (cents <= 0) return { error: 'O valor precisa ser maior que zero.' };
    return cents;
  } catch (error) {
    if (error instanceof MoneyParseError) return { error: `Não entendi o valor "${raw}".` };
    throw error;
  }
}

export async function transactionsAgent(request: AgentRequest): Promise<AgentResponse> {
  const intent = request.intent as TransactionsIntent;
  const schema = TRANSACTIONS_PAYLOAD_SCHEMAS[intent];

  if (!schema) {
    return fail('VALIDATION', `intent desconhecida: ${intent}`, 'Não sei fazer isso com gastos.');
  }

  const parsed = schema.safeParse(request.payload);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    return fail('VALIDATION', detail, 'Faltou informação para registrar esse gasto.');
  }

  const supabase = await createClient();
  const today = todayInTz(request.ctx.timezone);

  switch (intent) {
    case 'transactions.create':
      return create(supabase, request, parsed.data as never, today);
    case 'transactions.list':
      return list(supabase, parsed.data as never, today);
    case 'transactions.summarize':
      return summarize(supabase, parsed.data as never, today);
    case 'transactions.update':
      return update(supabase, request, parsed.data as never, today);
    case 'transactions.delete':
      return remove(supabase, parsed.data as never, today);
  }
}

// ---------------------------------------------------------------------------
// Catálogos
// ---------------------------------------------------------------------------

interface Catalogs {
  categoryIdByKey: Map<string, string>;
  categoryKeyById: Map<string, string>;
  categoryLabelByKey: Map<string, string>;
  profileIdByName: Map<string, string>;
  profileNameById: Map<string, string>;
}

async function loadCatalogs(supabase: Supabase): Promise<Catalogs> {
  const [{ data: categories }, { data: profiles }] = await Promise.all([
    supabase.from('categories').select('id, key, label'),
    supabase.from('profiles').select('id, display_name'),
  ]);

  const categoryIdByKey = new Map<string, string>();
  const categoryKeyById = new Map<string, string>();
  const categoryLabelByKey = new Map<string, string>();
  for (const row of categories ?? []) {
    categoryIdByKey.set(row.key as string, row.id as string);
    categoryKeyById.set(row.id as string, row.key as string);
    categoryLabelByKey.set(row.key as string, row.label as string);
  }

  const profileIdByName = new Map<string, string>();
  const profileNameById = new Map<string, string>();
  for (const row of profiles ?? []) {
    profileIdByName.set(row.display_name as string, row.id as string);
    profileNameById.set(row.id as string, row.display_name as string);
  }

  return { categoryIdByKey, categoryKeyById, categoryLabelByKey, profileIdByName, profileNameById };
}

function resolvePerson(catalogs: Catalogs, name: string | null): string | null {
  if (!name) return null;
  for (const [displayName, id] of catalogs.profileIdByName) {
    if (titleSimilarity(name, displayName) >= 0.5) return id;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Registrar
// ---------------------------------------------------------------------------

async function create(
  supabase: Supabase,
  request: AgentRequest,
  payload: {
    amount: string;
    dateExpression: string | null;
    kind: 'expense' | 'income';
    categoryKey: string | null;
    description: string | null;
    spentByName: string | null;
    rawText: string;
  },
  today: IsoDate,
): Promise<AgentResponse> {
  const amount = parseAmount(payload.amount);
  if (typeof amount !== 'number') return fail('VALIDATION', amount.error, amount.error);

  const occurredOn = resolveDateExpression(payload.dateExpression, today);
  if (occurredOn === null) {
    return fail(
      'AMBIGUOUS',
      `expressão de data não resolvida: "${payload.dateExpression}"`,
      `Não entendi quando foi esse gasto ("${payload.dateExpression}"). Foi que dia?`,
    );
  }

  // Gasto no futuro é quase sempre erro de extração, não intenção. Perguntar
  // custa uma frase; registrar num mês que ainda não aconteceu distorce o
  // fechamento do período sem ninguém perceber.
  if (occurredOn > today) {
    return fail(
      'AMBIGUOUS',
      `data futura: ${occurredOn}`,
      `Entendi a data como ${occurredOn}, que ainda não chegou. Foi quando mesmo?`,
    );
  }

  const catalogs = await loadCatalogs(supabase);
  const allowedKeys = [...catalogs.categoryIdByKey.keys()];
  const category = reconcileCategory(payload.categoryKey, payload.rawText, allowedKeys);

  const spentBy = resolvePerson(catalogs, payload.spentByName) ?? request.ctx.userId;

  const { data, error } = await supabase
    .from('transactions')
    .insert({
      household_id: request.ctx.householdId,
      kind: payload.kind,
      amount_cents: amount,
      category_id: category.key ? (catalogs.categoryIdByKey.get(category.key) ?? null) : null,
      occurred_on: occurredOn,
      description: payload.description,
      spent_by: spentBy,
      created_by: request.ctx.userId,
      source: 'agent',
      raw_input: payload.rawText,
      // Heurística acertando onde o modelo falhou é sinal de extração menos
      // confiável — fica registrado para a avaliação da Fase 3 poder medir.
      extraction_confidence: category.source === 'model' ? 0.9 : category.source === 'heuristic' ? 0.7 : 0.5,
    })
    .select('id')
    .single();

  if (error || !data) {
    return fail('DB', error?.message ?? 'insert falhou', 'Não consegui registrar esse gasto agora.');
  }

  const label = category.key
    ? (catalogs.categoryLabelByKey.get(category.key) ?? category.key)
    : (payload.description ?? 'Sem categoria');

  const blocks: UiBlock[] = [
    {
      type: 'transaction_card',
      transactionId: data.id as string,
      label,
      amountCents: amount,
      occurredOn,
    },
  ];

  const summaryParts = [
    `${payload.kind === 'income' ? 'Entrada' : 'Gasto'} registrado: ${formatCents(amount)}`,
    `categoria ${category.key ?? 'nenhuma'}`,
    `em ${occurredOn} (${relativeDayLabel(occurredOn, today)})`,
    `por ${catalogs.profileNameById.get(spentBy) ?? 'você'}`,
  ];

  if (category.source === 'none') {
    summaryParts.push('Não consegui classificar a categoria — vale perguntar ao usuário qual é.');
  }

  return {
    success: true,
    data: {
      transactionId: data.id,
      amountCents: amount,
      occurredOn,
      categoryKey: category.key,
      categorySource: category.source,
    },
    summaryForOrchestrator: `${summaryParts.join(', ')}.`,
    blocks,
    touched: ['transactions'],
  };
}

// ---------------------------------------------------------------------------
// Consultar
// ---------------------------------------------------------------------------

async function fetchTransactions(
  supabase: Supabase,
  filters: { from: IsoDate | null; to: IsoDate | null; categoryId?: string | null; limit: number },
): Promise<TransactionRow[] | { error: AgentResponse }> {
  let query = supabase
    .from('transactions')
    .select('id, kind, amount_cents, occurred_on, description, category_id, spent_by')
    .order('occurred_on', { ascending: false })
    .limit(filters.limit);

  if (filters.from) query = query.gte('occurred_on', filters.from);
  if (filters.to) query = query.lte('occurred_on', filters.to);
  if (filters.categoryId) query = query.eq('category_id', filters.categoryId);

  const { data, error } = await query;
  if (error) return { error: fail('DB', error.message, 'Não consegui consultar os gastos agora.') };

  return (data ?? []) as TransactionRow[];
}

async function list(
  supabase: Supabase,
  payload: { from: IsoDate | null; to: IsoDate | null; categoryKey: string | null; limit: number },
  today: IsoDate,
): Promise<AgentResponse> {
  const catalogs = await loadCatalogs(supabase);
  const categoryId = payload.categoryKey
    ? (catalogs.categoryIdByKey.get(payload.categoryKey) ?? null)
    : null;

  const rows = await fetchTransactions(supabase, { ...payload, categoryId });
  if ('error' in rows) return rows.error;

  if (rows.length === 0) {
    return {
      success: true,
      data: { count: 0 },
      summaryForOrchestrator: 'Nenhum gasto encontrado nesse período.',
    };
  }

  const total = rows.reduce((sum, row) => sum + row.amount_cents, 0);
  const lines = rows.slice(0, 15).map((row) => {
    const category = row.category_id ? catalogs.categoryKeyById.get(row.category_id) : null;
    const person = row.spent_by ? catalogs.profileNameById.get(row.spent_by) : null;
    return `- ${category ?? row.description ?? 'sem categoria'}: ${formatCents(row.amount_cents)}, ${relativeDayLabel(row.occurred_on, today)}${person ? ` (${person})` : ''}`;
  });

  return {
    success: true,
    data: { count: rows.length, totalCents: total },
    summaryForOrchestrator: `${rows.length} lançamento(s), somando ${formatCents(total)}:\n${lines.join('\n')}`,
  };
}

async function summarize(
  supabase: Supabase,
  payload: {
    from: IsoDate | null;
    to: IsoDate | null;
    groupBy: 'category' | 'person' | 'total';
    categoryKey: string | null;
  },
  today: IsoDate,
): Promise<AgentResponse> {
  // Sem período informado, o mês corrente é a leitura natural de "quanto gastei".
  const period = payload.from
    ? { start: payload.from, end: payload.to ?? today }
    : monthRange(today);

  const catalogs = await loadCatalogs(supabase);
  const categoryId = payload.categoryKey
    ? (catalogs.categoryIdByKey.get(payload.categoryKey) ?? null)
    : null;

  if (payload.categoryKey && !categoryId) {
    return fail(
      'NOT_FOUND',
      `categoria inexistente: ${payload.categoryKey}`,
      `Não tenho a categoria "${payload.categoryKey}" cadastrada.`,
    );
  }

  const rows = await fetchTransactions(supabase, {
    from: period.start,
    to: period.end,
    categoryId,
    limit: 1000,
  });
  if ('error' in rows) return rows.error;

  const expenses = rows.filter((row) => row.kind === 'expense');
  const totalCents = expenses.reduce((sum, row) => sum + row.amount_cents, 0);

  if (expenses.length === 0) {
    return {
      success: true,
      data: { totalCents: 0, count: 0, from: period.start, to: period.end },
      summaryForOrchestrator: `Nenhum gasto registrado entre ${period.start} e ${period.end}.`,
    };
  }

  const header = `Entre ${period.start} e ${period.end}: ${formatCents(totalCents)} em ${expenses.length} lançamento(s).`;

  if (payload.groupBy === 'total') {
    return {
      success: true,
      data: { totalCents, count: expenses.length, from: period.start, to: period.end },
      summaryForOrchestrator: header,
    };
  }

  const buckets = aggregateBy(
    expenses.map((row) => ({
      amountCents: row.amount_cents,
      categoryKey: row.category_id ? (catalogs.categoryKeyById.get(row.category_id) ?? null) : null,
      spentById: row.spent_by,
    })),
    payload.groupBy,
  );

  const naming = (key: string) =>
    payload.groupBy === 'person'
      ? (catalogs.profileNameById.get(key) ?? 'sem responsável')
      : (catalogs.categoryLabelByKey.get(key) ?? key);

  const lines = buckets
    .slice(0, 12)
    .map((bucket) => `- ${naming(bucket.key)}: ${formatCents(bucket.totalCents)} (${bucket.count}x)`);

  const blocks: UiBlock[] = [
    {
      type: 'category_bars',
      periodLabel: `${period.start} a ${period.end}`,
      items: buckets.slice(0, 6).map((bucket) => ({ label: naming(bucket.key), cents: bucket.totalCents })),
    },
  ];

  return {
    success: true,
    data: {
      totalCents,
      count: expenses.length,
      from: period.start,
      to: period.end,
      buckets: buckets.map((bucket) => ({ ...bucket, label: naming(bucket.key) })),
    },
    summaryForOrchestrator: `${header}\n${lines.join('\n')}`,
    blocks,
  };
}

// ---------------------------------------------------------------------------
// Corrigir e apagar
// ---------------------------------------------------------------------------

/**
 * "o último", "aquele de 80", "o do mercado" → uma linha de `transactions`.
 *
 * Sem match textual claro, o mais recente é o palpite certo: a correção quase
 * sempre vem logo depois do registro ("na verdade foi farmácia").
 */
async function resolveTransaction(
  supabase: Supabase,
  reference: string,
  catalogs: Catalogs,
): Promise<{ row: TransactionRow } | { error: AgentResponse }> {
  const rows = await fetchTransactions(supabase, { from: null, to: null, limit: 40 });
  if ('error' in rows) return rows;

  if (rows.length === 0) {
    return { error: fail('NOT_FOUND', 'sem transações', 'Você ainda não registrou nenhum gasto.') };
  }

  const byId = rows.find((row) => row.id === reference);
  if (byId) return { row: byId };

  const normalized = reference.toLowerCase();
  if (/\bultimo\b|\búltimo\b|\bmais recente\b|\besse\b|\bisso\b/.test(normalized)) {
    return { row: rows[0]! };
  }

  // Valor citado na referência: "aquele de 80 reais".
  try {
    const amount = parseBRLToCents(reference);
    const byAmount = rows.filter((row) => row.amount_cents === amount);
    if (byAmount.length === 1) return { row: byAmount[0]! };
    if (byAmount.length > 1) return { row: byAmount[0]! };
  } catch {
    // Referência sem valor — segue para a busca por categoria.
  }

  const scored = rows
    .map((row) => {
      const category = row.category_id ? (catalogs.categoryKeyById.get(row.category_id) ?? '') : '';
      const haystack = `${category} ${row.description ?? ''}`;
      return { row, score: titleSimilarity(reference, haystack) };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) return { row: rows[0]! };
  return { row: scored[0]!.row };
}

async function update(
  supabase: Supabase,
  request: AgentRequest,
  payload: {
    transaction: string;
    amount: string | null;
    dateExpression: string | null;
    categoryKey: string | null;
    description: string | null;
    spentByName: string | null;
  },
  today: IsoDate,
): Promise<AgentResponse> {
  const catalogs = await loadCatalogs(supabase);
  const resolved = await resolveTransaction(supabase, payload.transaction, catalogs);
  if ('error' in resolved) return resolved.error;

  const row = resolved.row;
  const patch: Record<string, unknown> = {};
  const corrections: Array<{ field: string; oldValue: string | null; newValue: string | null }> = [];
  const changes: string[] = [];

  if (payload.amount) {
    const amount = parseAmount(payload.amount);
    if (typeof amount !== 'number') return fail('VALIDATION', amount.error, amount.error);
    patch['amount_cents'] = amount;
    corrections.push({
      field: 'amount_cents',
      oldValue: String(row.amount_cents),
      newValue: String(amount),
    });
    changes.push(`valor para ${formatCents(amount)}`);
  }

  if (payload.dateExpression) {
    const occurredOn = resolveDateExpression(payload.dateExpression, today);
    if (occurredOn === null) {
      return fail(
        'AMBIGUOUS',
        `data não resolvida: "${payload.dateExpression}"`,
        `Não entendi a data "${payload.dateExpression}". Foi que dia?`,
      );
    }
    patch['occurred_on'] = occurredOn;
    corrections.push({ field: 'occurred_on', oldValue: row.occurred_on, newValue: occurredOn });
    changes.push(`data para ${occurredOn}`);
  }

  if (payload.categoryKey) {
    const categoryId = catalogs.categoryIdByKey.get(payload.categoryKey);
    if (!categoryId) {
      return fail(
        'NOT_FOUND',
        `categoria inexistente: ${payload.categoryKey}`,
        `Não tenho a categoria "${payload.categoryKey}". As que existem são outras.`,
      );
    }
    patch['category_id'] = categoryId;
    corrections.push({
      field: 'category_id',
      oldValue: row.category_id ? (catalogs.categoryKeyById.get(row.category_id) ?? null) : null,
      newValue: payload.categoryKey,
    });
    changes.push(`categoria para ${payload.categoryKey}`);
  }

  if (payload.description) {
    patch['description'] = payload.description;
    changes.push('descrição');
  }

  if (payload.spentByName) {
    const personId = resolvePerson(catalogs, payload.spentByName);
    if (personId) {
      patch['spent_by'] = personId;
      corrections.push({
        field: 'spent_by',
        oldValue: row.spent_by ? (catalogs.profileNameById.get(row.spent_by) ?? null) : null,
        newValue: payload.spentByName,
      });
      changes.push(`responsável para ${payload.spentByName}`);
    }
  }

  if (Object.keys(patch).length === 0) {
    return fail('VALIDATION', 'nada para alterar', 'Não entendi o que mudar nesse gasto.');
  }

  const { error } = await supabase.from('transactions').update(patch).eq('id', row.id);
  if (error) return fail('DB', error.message, 'Não consegui corrigir esse gasto.');

  /*
   * A correção é gravada como evento, não só aplicada.
   *
   * O brief pede que corrigir a categoria vire sinal de aprendizado (§2.1): é
   * daqui que o Agente de Memória da Fase 5 tira padrões do tipo "quando ele diz
   * 'padaria', é mercado, não restaurante". Um UPDATE puro apagaria justamente a
   * informação de que houve um erro.
   */
  if (corrections.length > 0) {
    await supabase.from('transaction_corrections').insert(
      corrections.map((correction) => ({
        transaction_id: row.id,
        household_id: request.ctx.householdId,
        field: correction.field,
        old_value: correction.oldValue,
        new_value: correction.newValue,
        corrected_by: request.ctx.userId,
      })),
    );
  }

  const categoryCorrection = corrections.find((correction) => correction.field === 'category_id');
  const memoryCandidates: MemoryCandidate[] = categoryCorrection
    ? [
        {
          content:
            `Quando a família descreve um gasto como "${row.description ?? payload.transaction}", ` +
            `a categoria correta é "${categoryCorrection.newValue}", não "${categoryCorrection.oldValue ?? 'nenhuma'}".`,
          kind: 'pattern',
          scope: 'household',
          source: 'correction',
          sourceRef: row.id,
          confidence: 0.7,
        },
      ]
    : [];

  return {
    success: true,
    data: { transactionId: row.id, corrections: corrections.length },
    summaryForOrchestrator: `Gasto corrigido: ${changes.join(', ')}.`,
    memoryCandidates,
    touched: ['transactions'],
  };
}

async function remove(
  supabase: Supabase,
  payload: { transaction: string },
  today: IsoDate,
): Promise<AgentResponse> {
  const catalogs = await loadCatalogs(supabase);
  const resolved = await resolveTransaction(supabase, payload.transaction, catalogs);
  if ('error' in resolved) return resolved.error;

  const row = resolved.row;

  // DELETE de verdade, não flag: requisito 5.5 do brief. Um gasto lançado por
  // engano não é histórico, é lixo, e o usuário mandou apagar.
  const { error } = await supabase.from('transactions').delete().eq('id', row.id);
  if (error) return fail('DB', error.message, 'Não consegui apagar esse gasto.');

  const category = row.category_id ? (catalogs.categoryKeyById.get(row.category_id) ?? null) : null;

  return {
    success: true,
    data: { transactionId: row.id },
    summaryForOrchestrator:
      `Gasto apagado: ${formatCents(row.amount_cents)}, ${category ?? 'sem categoria'}, ` +
      `${relativeDayLabel(row.occurred_on, today)}.`,
    touched: ['transactions'],
  };
}
