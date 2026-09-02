import 'server-only';
import { addDays, format, parseISO } from 'date-fns';
import { dueLabel, todayInTz, type IsoDate } from '@/lib/dates';
import { formatCents, MoneyParseError, parseBRLToCents, type Cents } from '@/lib/money';
import { createClient } from '@/server/db/server';
import type {
  AgentRequest,
  AgentResponse,
  MemoryCandidate,
  UiBlock,
} from '@/server/agents/shared/contracts';
import {
  findPotentialDuplicates,
  generateOccurrenceDates,
  sortByAttention,
  titleSimilarity,
  type BillFingerprint,
} from './logic';
import { BILLS_PAYLOAD_SCHEMAS, type BillsIntent } from './schemas';

/**
 * Agente de Contas a Pagar.
 *
 * Divisão de trabalho: o LLM já traduziu a frase em intenção + payload antes de
 * chegar aqui. Este módulo valida esse payload, resolve referências ("a conta de
 * luz" → um id), executa no banco e devolve um resumo factual. Nenhuma decisão
 * de negócio depende do modelo — recorrência, atraso e duplicata são calculados
 * em `logic.ts`, que tem teste.
 */

/** Quanto do futuro materializar ao criar uma conta recorrente. */
const OCCURRENCE_HORIZON_MONTHS = 12;

type Supabase = Awaited<ReturnType<typeof createClient>>;

interface OccurrenceRow {
  id: string;
  bill_id: string;
  due_date: string;
  amount_cents: number;
  status: 'pending' | 'paid' | 'cancelled';
  bills: { title: string; category_id: string | null; responsible_id: string | null } | null;
}

function fail(
  code: 'VALIDATION' | 'NOT_FOUND' | 'AMBIGUOUS' | 'DB',
  message: string,
  userFacing: string,
): AgentResponse {
  return {
    success: false,
    error: { code, message, retryable: false },
    summaryForOrchestrator: userFacing,
  };
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

export async function billsAgent(request: AgentRequest): Promise<AgentResponse> {
  const intent = request.intent as BillsIntent;
  const schema = BILLS_PAYLOAD_SCHEMAS[intent];

  if (!schema) {
    return fail('VALIDATION', `intent desconhecida: ${intent}`, 'Não sei fazer isso com contas.');
  }

  const parsed = schema.safeParse(request.payload);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    return fail('VALIDATION', detail, 'Faltou informação para registrar essa conta.');
  }

  const supabase = await createClient();
  const today = todayInTz(request.ctx.timezone);

  switch (intent) {
    case 'bills.create':
      return create(supabase, request, parsed.data as never, today);
    case 'bills.list':
      return list(supabase, parsed.data as never, today);
    case 'bills.overdue':
      return overdue(supabase, today);
    case 'bills.mark_paid':
      return markPaid(supabase, request, parsed.data as never, today);
    case 'bills.update':
      return update(supabase, parsed.data as never, today);
    case 'bills.delete':
      return remove(supabase, parsed.data as never, today);
  }
}

// ---------------------------------------------------------------------------
// Resolução de referências pelo nome
// ---------------------------------------------------------------------------

interface BillRow {
  id: string;
  title: string;
  amount_cents: number;
  starts_on: string;
  recurrence: string;
  recurrence_day: number | null;
  ends_on: string | null;
  is_active: boolean;
}

/**
 * "a conta de luz" → uma linha de `bills`.
 *
 * Duas ou mais candidatas plausíveis não é erro: é AMBIGUOUS, que o orquestrador
 * transforma em pergunta. Escolher a mais parecida e seguir seria adivinhar com
 * o dinheiro dos outros.
 */
async function resolveBill(
  supabase: Supabase,
  reference: string,
): Promise<{ bill: BillRow } | { error: AgentResponse }> {
  const { data, error } = await supabase
    .from('bills')
    .select('id, title, amount_cents, starts_on, recurrence, recurrence_day, ends_on, is_active')
    .eq('is_active', true);

  if (error) {
    return { error: fail('DB', error.message, 'Não consegui consultar as contas agora.') };
  }

  const bills = (data ?? []) as BillRow[];

  const byId = bills.find((bill) => bill.id === reference);
  if (byId) return { bill: byId };

  const scored = bills
    .map((bill) => ({ bill, score: titleSimilarity(reference, bill.title) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) {
    return {
      error: fail(
        'NOT_FOUND',
        `nenhuma conta parecida com "${reference}"`,
        `Não achei nenhuma conta chamada "${reference}".`,
      ),
    };
  }

  const best = scored[0]!;
  const runnerUp = scored[1];

  // Empate real: duas contas igualmente parecidas. Perguntar é mais barato que
  // marcar a conta errada como paga.
  if (runnerUp && runnerUp.score >= best.score * 0.9) {
    const names = scored
      .filter((entry) => entry.score >= best.score * 0.9)
      .map((entry) => entry.bill.title);
    return {
      error: fail(
        'AMBIGUOUS',
        `"${reference}" casa com ${names.join(', ')}`,
        `Achei mais de uma conta que pode ser essa: ${names.join(', ')}. Qual delas?`,
      ),
    };
  }

  return { bill: best.bill };
}

async function resolveCategoryId(supabase: Supabase, key: string | null): Promise<string | null> {
  if (!key) return null;
  const { data } = await supabase.from('categories').select('id').eq('key', key).limit(1);
  return (data?.[0]?.id as string | undefined) ?? null;
}

async function resolveProfileId(supabase: Supabase, name: string | null): Promise<string | null> {
  if (!name) return null;
  const { data } = await supabase.from('profiles').select('id, display_name');
  const match = (data ?? []).find(
    (row) => titleSimilarity(name, row.display_name as string) >= 0.5,
  );
  return (match?.id as string | undefined) ?? null;
}

// ---------------------------------------------------------------------------
// Intenções
// ---------------------------------------------------------------------------

async function create(
  supabase: Supabase,
  request: AgentRequest,
  payload: {
    title: string;
    amount: string;
    dueDate: IsoDate;
    recurrence: 'none' | 'weekly' | 'monthly' | 'quarterly' | 'yearly';
    recurrenceDay: number | null;
    categoryKey: string | null;
    responsibleName: string | null;
    notes: string | null;
    confirmDuplicate: boolean;
  },
  today: IsoDate,
): Promise<AgentResponse> {
  const amount = parseAmount(payload.amount);
  if (typeof amount !== 'number') {
    return fail('VALIDATION', amount.error, amount.error);
  }

  // Recorrência mensal sem dia informado: usar o dia do primeiro vencimento é a
  // leitura óbvia de "todo mês, vencendo dia 15".
  const recurrenceDay =
    payload.recurrence === 'none' || payload.recurrence === 'weekly'
      ? null
      : (payload.recurrenceDay ?? Number(payload.dueDate.slice(8, 10)));

  if (!payload.confirmDuplicate) {
    const { data } = await supabase
      .from('bill_occurrences')
      .select('id, due_date, amount_cents, bills ( title )')
      .eq('status', 'pending');

    const fingerprints: BillFingerprint[] = ((data ?? []) as unknown as OccurrenceRow[]).map(
      (row) => ({
        id: row.id,
        title: row.bills?.title ?? '',
        amountCents: row.amount_cents,
        dueDate: row.due_date,
      }),
    );

    const duplicates = findPotentialDuplicates(
      { title: payload.title, amountCents: amount, dueDate: payload.dueDate },
      fingerprints,
    );

    if (duplicates[0] && duplicates[0].confidence >= 0.9) {
      const existing = fingerprints.find((f) => f.id === duplicates[0]!.billId)!;
      return fail(
        'AMBIGUOUS',
        `possível duplicata de ${existing.id}`,
        `Já existe "${existing.title}" de ${formatCents(existing.amountCents)} vencendo em ${existing.dueDate}. É a mesma conta ou uma nova?`,
      );
    }
  }

  const [categoryId, responsibleId] = await Promise.all([
    resolveCategoryId(supabase, payload.categoryKey),
    resolveProfileId(supabase, payload.responsibleName),
  ]);

  const { data: bill, error: billError } = await supabase
    .from('bills')
    .insert({
      household_id: request.ctx.householdId,
      title: payload.title,
      amount_cents: amount,
      category_id: categoryId,
      recurrence: payload.recurrence,
      recurrence_day: recurrenceDay,
      starts_on: payload.dueDate,
      responsible_id: responsibleId,
      created_by: request.ctx.userId,
      notes: payload.notes,
    })
    .select('id')
    .single();

  if (billError || !bill) {
    return fail('DB', billError?.message ?? 'insert falhou', 'Não consegui salvar a conta agora.');
  }

  const horizonEnd = format(
    parseISO(`${payload.dueDate.slice(0, 8)}01`),
    'yyyy-MM-dd',
  );
  const dates = generateOccurrenceDates(
    {
      recurrence: payload.recurrence,
      startsOn: payload.dueDate,
      endsOn: null,
      recurrenceDay,
    },
    payload.dueDate,
    format(addMonthsIso(horizonEnd, OCCURRENCE_HORIZON_MONTHS), 'yyyy-MM-dd'),
  );

  const { data: occurrences, error: occurrenceError } = await supabase
    .from('bill_occurrences')
    .insert(
      dates.map((dueDate) => ({
        bill_id: bill.id,
        household_id: request.ctx.householdId,
        due_date: dueDate,
        amount_cents: amount,
      })),
    )
    .select('id, due_date');

  if (occurrenceError) {
    // A definição existe mas sem vencimento nenhum é pior que não existir:
    // sumiria do dashboard e ninguém notaria.
    await supabase.from('bills').delete().eq('id', bill.id);
    return fail('DB', occurrenceError.message, 'Não consegui agendar os vencimentos dessa conta.');
  }

  const first = (occurrences ?? [])[0];
  const blocks: UiBlock[] = first
    ? [
        {
          type: 'bill_card',
          occurrenceId: first.id as string,
          title: payload.title,
          amountCents: amount,
          dueDate: first.due_date as string,
          status: 'pending',
        },
      ]
    : [];

  const memoryCandidates: MemoryCandidate[] = payload.responsibleName
    ? [
        {
          content: `${payload.responsibleName} é responsável pela conta "${payload.title}".`,
          kind: 'fact',
          scope: 'household',
          source: 'chat',
          confidence: 0.8,
        },
      ]
    : [];

  const recurrenceLabel =
    payload.recurrence === 'none' ? 'avulsa' : `recorrente (${payload.recurrence})`;

  return {
    success: true,
    data: { billId: bill.id, occurrenceId: first?.id ?? null, occurrencesCreated: dates.length },
    summaryForOrchestrator:
      `Conta "${payload.title}" criada: ${formatCents(amount)}, ${recurrenceLabel}, ` +
      `primeiro vencimento em ${payload.dueDate} (${dueLabel(payload.dueDate, today)}). ` +
      `${dates.length} vencimento(s) agendado(s).`,
    blocks,
    memoryCandidates,
    touched: ['bills', 'bill_occurrences'],
  };
}

function addMonthsIso(iso: IsoDate, months: number): Date {
  const date = parseISO(iso);
  date.setMonth(date.getMonth() + months);
  return date;
}

async function fetchOccurrences(
  supabase: Supabase,
  filters: { status?: string; from?: IsoDate | null; to?: IsoDate | null; limit: number },
): Promise<OccurrenceRow[] | { error: AgentResponse }> {
  let query = supabase
    .from('bill_occurrences')
    .select('id, bill_id, due_date, amount_cents, status, bills ( title, category_id, responsible_id )')
    .order('due_date', { ascending: true })
    .limit(filters.limit);

  if (filters.status && filters.status !== 'all') query = query.eq('status', filters.status);
  if (filters.from) query = query.gte('due_date', filters.from);
  if (filters.to) query = query.lte('due_date', filters.to);

  const { data, error } = await query;
  if (error) return { error: fail('DB', error.message, 'Não consegui consultar as contas agora.') };

  return (data ?? []) as unknown as OccurrenceRow[];
}

function describe(rows: OccurrenceRow[], today: IsoDate): string {
  if (rows.length === 0) return 'Nenhuma conta encontrada com esses critérios.';

  const sorted = sortByAttention(
    rows.map((row) => ({ ...row, dueDate: row.due_date, amountCents: row.amount_cents })),
    today,
  );

  const total = sorted.reduce((sum, row) => sum + row.amount_cents, 0);
  const lines = sorted
    .slice(0, 15)
    .map(
      (row) =>
        `- ${row.bills?.title ?? 'Conta'}: ${formatCents(row.amount_cents)}, ${dueLabel(row.due_date, today)}`,
    );

  return `${sorted.length} conta(s), somando ${formatCents(total)}:\n${lines.join('\n')}`;
}

async function list(
  supabase: Supabase,
  payload: { status: string; from: IsoDate | null; to: IsoDate | null; limit: number },
  today: IsoDate,
): Promise<AgentResponse> {
  const rows = await fetchOccurrences(supabase, payload);
  if ('error' in rows) return rows.error;

  return {
    success: true,
    data: { count: rows.length, occurrenceIds: rows.map((row) => row.id) },
    summaryForOrchestrator: describe(rows, today),
  };
}

async function overdue(supabase: Supabase, today: IsoDate): Promise<AgentResponse> {
  const rows = await fetchOccurrences(supabase, {
    status: 'pending',
    to: format(addDays(parseISO(today), -1), 'yyyy-MM-dd'),
    limit: 50,
  });
  if ('error' in rows) return rows.error;

  return {
    success: true,
    data: { count: rows.length },
    summaryForOrchestrator:
      rows.length === 0 ? 'Nenhuma conta em atraso.' : describe(rows, today),
  };
}

async function markPaid(
  supabase: Supabase,
  request: AgentRequest,
  payload: { bill: string; paidOn: IsoDate | null; amount: string | null },
  today: IsoDate,
): Promise<AgentResponse> {
  const resolved = await resolveBill(supabase, payload.bill);
  if ('error' in resolved) return resolved.error;

  // A pendente mais antiga é a que se paga primeiro.
  const { data, error } = await supabase
    .from('bill_occurrences')
    .select('id, due_date, amount_cents')
    .eq('bill_id', resolved.bill.id)
    .eq('status', 'pending')
    .order('due_date', { ascending: true })
    .limit(1);

  if (error) return fail('DB', error.message, 'Não consegui consultar essa conta.');

  const occurrence = data?.[0];
  if (!occurrence) {
    return fail(
      'NOT_FOUND',
      `sem ocorrência pendente para ${resolved.bill.id}`,
      `"${resolved.bill.title}" não tem nenhum vencimento em aberto.`,
    );
  }

  const patch: Record<string, unknown> = {
    status: 'paid',
    paid_at: new Date().toISOString(),
    paid_by: request.ctx.userId,
  };

  if (payload.amount) {
    const amount = parseAmount(payload.amount);
    if (typeof amount !== 'number') return fail('VALIDATION', amount.error, amount.error);
    patch['amount_cents'] = amount;
  }

  const { error: updateError } = await supabase
    .from('bill_occurrences')
    .update(patch)
    .eq('id', occurrence.id);

  if (updateError) return fail('DB', updateError.message, 'Não consegui marcar como paga.');

  const paidCents = (patch['amount_cents'] as number | undefined) ?? occurrence.amount_cents;

  return {
    success: true,
    data: { occurrenceId: occurrence.id, billId: resolved.bill.id, amountCents: paidCents },
    summaryForOrchestrator:
      `"${resolved.bill.title}" marcada como paga: ${formatCents(paidCents)}, ` +
      `vencimento ${occurrence.due_date} (hoje é ${today}).`,
    blocks: [
      {
        type: 'bill_card',
        occurrenceId: occurrence.id,
        title: resolved.bill.title,
        amountCents: paidCents,
        dueDate: occurrence.due_date,
        status: 'paid',
      },
    ],
    touched: ['bill_occurrences'],
  };
}

async function update(
  supabase: Supabase,
  payload: {
    bill: string;
    title: string | null;
    amount: string | null;
    dueDate: IsoDate | null;
    recurrence: string | null;
    recurrenceDay: number | null;
    categoryKey: string | null;
    responsibleName: string | null;
  },
  _today: IsoDate,
): Promise<AgentResponse> {
  const resolved = await resolveBill(supabase, payload.bill);
  if ('error' in resolved) return resolved.error;

  const patch: Record<string, unknown> = {};
  const changes: string[] = [];

  if (payload.title) {
    patch['title'] = payload.title;
    changes.push(`título para "${payload.title}"`);
  }
  if (payload.amount) {
    const amount = parseAmount(payload.amount);
    if (typeof amount !== 'number') return fail('VALIDATION', amount.error, amount.error);
    patch['amount_cents'] = amount;
    changes.push(`valor para ${formatCents(amount)}`);
  }
  if (payload.recurrence) {
    patch['recurrence'] = payload.recurrence;
    changes.push(`recorrência para ${payload.recurrence}`);
  }
  if (payload.recurrenceDay) {
    patch['recurrence_day'] = payload.recurrenceDay;
    changes.push(`dia do vencimento para ${payload.recurrenceDay}`);
  }
  if (payload.categoryKey) {
    patch['category_id'] = await resolveCategoryId(supabase, payload.categoryKey);
    changes.push(`categoria para ${payload.categoryKey}`);
  }
  if (payload.responsibleName) {
    patch['responsible_id'] = await resolveProfileId(supabase, payload.responsibleName);
    changes.push(`responsável para ${payload.responsibleName}`);
  }

  if (Object.keys(patch).length === 0) {
    return fail('VALIDATION', 'nenhum campo para alterar', 'Não entendi o que mudar nessa conta.');
  }

  const { error } = await supabase.from('bills').update(patch).eq('id', resolved.bill.id);
  if (error) return fail('DB', error.message, 'Não consegui alterar essa conta.');

  // As ocorrências pendentes seguem o novo valor; as pagas ficam como estão,
  // porque são histórico e reescrever histórico apaga o que de fato aconteceu.
  if (patch['amount_cents']) {
    await supabase
      .from('bill_occurrences')
      .update({ amount_cents: patch['amount_cents'] })
      .eq('bill_id', resolved.bill.id)
      .eq('status', 'pending');
  }

  return {
    success: true,
    data: { billId: resolved.bill.id },
    summaryForOrchestrator: `"${resolved.bill.title}" atualizada: ${changes.join(', ')}.`,
    touched: ['bills', 'bill_occurrences'],
  };
}

async function remove(
  supabase: Supabase,
  payload: { bill: string; scope: 'occurrence' | 'bill' },
  today: IsoDate,
): Promise<AgentResponse> {
  const resolved = await resolveBill(supabase, payload.bill);
  if ('error' in resolved) return resolved.error;

  if (payload.scope === 'occurrence') {
    const { data } = await supabase
      .from('bill_occurrences')
      .select('id, due_date')
      .eq('bill_id', resolved.bill.id)
      .eq('status', 'pending')
      .gte('due_date', today)
      .order('due_date', { ascending: true })
      .limit(1);

    const occurrence = data?.[0];
    if (!occurrence) {
      return fail(
        'NOT_FOUND',
        'sem ocorrência futura',
        `"${resolved.bill.title}" não tem vencimento futuro para cancelar.`,
      );
    }

    const { error } = await supabase
      .from('bill_occurrences')
      .update({ status: 'cancelled' })
      .eq('id', occurrence.id);

    if (error) return fail('DB', error.message, 'Não consegui cancelar esse vencimento.');

    return {
      success: true,
      data: { occurrenceId: occurrence.id },
      summaryForOrchestrator: `Vencimento de "${resolved.bill.title}" em ${occurrence.due_date} cancelado. A conta segue ativa.`,
      touched: ['bill_occurrences'],
    };
  }

  // Desativa em vez de apagar: as ocorrências pagas são histórico de pagamento,
  // e o Insights da Fase 6 depende delas. "Apagar de verdade" no brief vale para
  // memórias e dado pessoal, não para desfazer o passado financeiro da casa.
  const { error } = await supabase
    .from('bills')
    .update({ is_active: false })
    .eq('id', resolved.bill.id);

  if (error) return fail('DB', error.message, 'Não consegui remover essa conta.');

  await supabase
    .from('bill_occurrences')
    .update({ status: 'cancelled' })
    .eq('bill_id', resolved.bill.id)
    .eq('status', 'pending');

  return {
    success: true,
    data: { billId: resolved.bill.id },
    summaryForOrchestrator: `"${resolved.bill.title}" removida. Os vencimentos futuros foram cancelados; o histórico de pagamentos foi preservado.`,
    touched: ['bills', 'bill_occurrences'],
  };
}
