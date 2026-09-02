import 'server-only';
import { deadlineLabel, todayInTz, type IsoDate } from '@/lib/dates';
import { createClient } from '@/server/db/server';
import { titleSimilarity } from '@/server/agents/bills/logic';
import type {
  AgentRequest,
  AgentResponse,
  MemoryCandidate,
  UiBlock,
} from '@/server/agents/shared/contracts';
import { canTransition, resolveDeadline, sortTasksByUrgency, type TaskStatus } from './logic';
import { TASKS_PAYLOAD_SCHEMAS, type TasksIntent } from './schemas';

/**
 * Agente de Tarefas financeiras.
 *
 * O agente mais simples do sistema, e o único cuja falha não distorce nenhum
 * número: uma tarefa perdida é um esquecimento, não um dado corrompido. Por isso
 * roda em Haiku e não faz nenhuma checagem cara.
 */

type Supabase = Awaited<ReturnType<typeof createClient>>;

interface TaskRow {
  id: string;
  title: string;
  description: string | null;
  due_date: string | null;
  status: TaskStatus;
  assignee_id: string | null;
  bill_id: string | null;
}

function fail(
  code: 'VALIDATION' | 'NOT_FOUND' | 'AMBIGUOUS' | 'DB',
  message: string,
  userFacing: string,
): AgentResponse {
  return { success: false, error: { code, message, retryable: false }, summaryForOrchestrator: userFacing };
}

export async function tasksAgent(request: AgentRequest): Promise<AgentResponse> {
  const intent = request.intent as TasksIntent;
  const schema = TASKS_PAYLOAD_SCHEMAS[intent];

  if (!schema) {
    return fail('VALIDATION', `intent desconhecida: ${intent}`, 'Não sei fazer isso com tarefas.');
  }

  const parsed = schema.safeParse(request.payload);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    return fail('VALIDATION', detail, 'Faltou informação para criar essa tarefa.');
  }

  const supabase = await createClient();
  const today = todayInTz(request.ctx.timezone);

  switch (intent) {
    case 'tasks.create':
      return create(supabase, request, parsed.data as never, today);
    case 'tasks.list':
      return list(supabase, parsed.data as never, today);
    case 'tasks.update':
      return update(supabase, parsed.data as never, today);
    case 'tasks.complete':
      return complete(supabase, parsed.data as never, today);
    case 'tasks.delete':
      return remove(supabase, parsed.data as never, today);
  }
}

// ---------------------------------------------------------------------------
// Resolução
// ---------------------------------------------------------------------------

async function resolveAssignee(supabase: Supabase, name: string | null): Promise<string | null> {
  if (!name) return null;
  const { data } = await supabase.from('profiles').select('id, display_name');
  const match = (data ?? []).find((row) => titleSimilarity(name, row.display_name as string) >= 0.5);
  return (match?.id as string | undefined) ?? null;
}

async function resolveRelatedBill(supabase: Supabase, reference: string | null): Promise<string | null> {
  if (!reference) return null;

  const { data } = await supabase.from('bills').select('id, title').eq('is_active', true);

  const scored = (data ?? [])
    .map((row) => ({ id: row.id as string, score: titleSimilarity(reference, row.title as string) }))
    .filter((entry) => entry.score >= 0.5)
    .sort((a, b) => b.score - a.score);

  // Vínculo com conta é conveniência, não requisito. Não achando, a tarefa
  // existe do mesmo jeito — falhar aqui seria perder a tarefa por um detalhe.
  return scored[0]?.id ?? null;
}

async function resolveTask(
  supabase: Supabase,
  reference: string,
  today: IsoDate,
): Promise<{ row: TaskRow } | { error: AgentResponse }> {
  const { data, error } = await supabase
    .from('tasks')
    .select('id, title, description, due_date, status, assignee_id, bill_id')
    .order('created_at', { ascending: false })
    .limit(60);

  if (error) return { error: fail('DB', error.message, 'Não consegui consultar as tarefas.') };

  const rows = (data ?? []) as TaskRow[];
  if (rows.length === 0) {
    return { error: fail('NOT_FOUND', 'sem tarefas', 'Você ainda não tem nenhuma tarefa.') };
  }

  const byId = rows.find((row) => row.id === reference);
  if (byId) return { row: byId };

  if (/\bultima\b|\búltima\b|\bmais recente\b/i.test(reference)) return { row: rows[0]! };

  const open = rows.filter((row) => row.status === 'todo' || row.status === 'doing');
  const pool = open.length > 0 ? open : rows;

  const scored = pool
    .map((row) => ({ row, score: titleSimilarity(reference, `${row.title} ${row.description ?? ''}`) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) {
    return {
      error: fail(
        'NOT_FOUND',
        `nenhuma tarefa parecida com "${reference}"`,
        `Não achei nenhuma tarefa parecida com "${reference}".`,
      ),
    };
  }

  const best = scored[0]!;
  const runnerUp = scored[1];

  if (runnerUp && runnerUp.score >= best.score * 0.9) {
    const titles = scored
      .filter((entry) => entry.score >= best.score * 0.9)
      .map((entry) => `"${entry.row.title}" (${deadlineLabel(entry.row.due_date, today)})`);
    return {
      error: fail(
        'AMBIGUOUS',
        `"${reference}" casa com várias`,
        `Tenho mais de uma tarefa parecida: ${titles.join(', ')}. Qual delas?`,
      ),
    };
  }

  return { row: best.row };
}

// ---------------------------------------------------------------------------
// Intenções
// ---------------------------------------------------------------------------

async function create(
  supabase: Supabase,
  request: AgentRequest,
  payload: {
    title: string;
    description: string | null;
    deadlineExpression: string | null;
    assigneeName: string | null;
    relatedBill: string | null;
  },
  today: IsoDate,
): Promise<AgentResponse> {
  const deadline = resolveDeadline(payload.deadlineExpression, today);

  // `null` (mencionou prazo mas não deu para entender) é diferente de
  // `undefined` (não mencionou prazo nenhum). Só o primeiro vira pergunta.
  if (deadline === null) {
    return fail(
      'AMBIGUOUS',
      `prazo não resolvido: "${payload.deadlineExpression}"`,
      `Não entendi o prazo "${payload.deadlineExpression}". Para quando é?`,
    );
  }

  const [assigneeId, billId] = await Promise.all([
    resolveAssignee(supabase, payload.assigneeName),
    resolveRelatedBill(supabase, payload.relatedBill),
  ]);

  const { data, error } = await supabase
    .from('tasks')
    .insert({
      household_id: request.ctx.householdId,
      title: payload.title,
      description: payload.description,
      due_date: deadline ?? null,
      assignee_id: assigneeId ?? request.ctx.userId,
      bill_id: billId,
      created_by: request.ctx.userId,
    })
    .select('id')
    .single();

  if (error || !data) {
    return fail('DB', error?.message ?? 'insert falhou', 'Não consegui criar essa tarefa agora.');
  }

  const blocks: UiBlock[] = [
    {
      type: 'task_card',
      taskId: data.id as string,
      title: payload.title,
      dueDate: deadline ?? null,
    },
  ];

  const memoryCandidates: MemoryCandidate[] = payload.relatedBill && billId
    ? [
        {
          content: `A família tem uma tarefa em aberto relacionada à conta "${payload.relatedBill}": ${payload.title}.`,
          kind: 'fact',
          scope: 'household',
          source: 'chat',
          sourceRef: data.id as string,
          confidence: 0.6,
        },
      ]
    : [];

  return {
    success: true,
    data: { taskId: data.id, dueDate: deadline ?? null, billId },
    summaryForOrchestrator:
      `Tarefa criada: "${payload.title}", ${deadlineLabel(deadline ?? null, today)}` +
      `${billId ? ', vinculada a uma conta cadastrada' : ''}.`,
    blocks,
    memoryCandidates,
    touched: ['tasks'],
  };
}

async function list(
  supabase: Supabase,
  payload: { status: string; assigneeName: string | null; limit: number },
  today: IsoDate,
): Promise<AgentResponse> {
  let query = supabase
    .from('tasks')
    .select('id, title, description, due_date, status, assignee_id, bill_id')
    .limit(payload.limit);

  if (payload.status === 'open') query = query.in('status', ['todo', 'doing']);
  else if (payload.status !== 'all') query = query.eq('status', payload.status);

  if (payload.assigneeName) {
    const assigneeId = await resolveAssignee(supabase, payload.assigneeName);
    if (assigneeId) query = query.eq('assignee_id', assigneeId);
  }

  const { data, error } = await query;
  if (error) return fail('DB', error.message, 'Não consegui consultar as tarefas.');

  const rows = (data ?? []) as TaskRow[];
  if (rows.length === 0) {
    return {
      success: true,
      data: { count: 0 },
      summaryForOrchestrator: 'Nenhuma tarefa encontrada com esses critérios.',
    };
  }

  const sorted = sortTasksByUrgency(
    rows.map((row) => ({ ...row, dueDate: row.due_date })),
    today,
  );

  const lines = sorted
    .slice(0, 20)
    .map((row) => `- ${row.title} (${deadlineLabel(row.due_date, today)}, ${row.status})`);

  const overdue = sorted.filter(
    (row) => row.due_date !== null && row.due_date < today && (row.status === 'todo' || row.status === 'doing'),
  ).length;

  return {
    success: true,
    data: { count: rows.length, overdue },
    summaryForOrchestrator:
      `${rows.length} tarefa(s)${overdue > 0 ? `, sendo ${overdue} atrasada(s)` : ''}:\n${lines.join('\n')}`,
  };
}

async function update(
  supabase: Supabase,
  payload: {
    task: string;
    title: string | null;
    description: string | null;
    deadlineExpression: string | null;
    assigneeName: string | null;
    status: TaskStatus | null;
  },
  today: IsoDate,
): Promise<AgentResponse> {
  const resolved = await resolveTask(supabase, payload.task, today);
  if ('error' in resolved) return resolved.error;

  const row = resolved.row;
  const patch: Record<string, unknown> = {};
  const changes: string[] = [];

  if (payload.title) {
    patch['title'] = payload.title;
    changes.push(`título para "${payload.title}"`);
  }
  if (payload.description) {
    patch['description'] = payload.description;
    changes.push('descrição');
  }

  if (payload.deadlineExpression) {
    const deadline = resolveDeadline(payload.deadlineExpression, today);
    if (deadline === null) {
      return fail(
        'AMBIGUOUS',
        `prazo não resolvido: "${payload.deadlineExpression}"`,
        `Não entendi o prazo "${payload.deadlineExpression}". Para quando é?`,
      );
    }
    patch['due_date'] = deadline ?? null;
    changes.push(`prazo ${deadlineLabel(deadline ?? null, today)}`);
  }

  if (payload.assigneeName) {
    const assigneeId = await resolveAssignee(supabase, payload.assigneeName);
    if (assigneeId) {
      patch['assignee_id'] = assigneeId;
      changes.push(`responsável para ${payload.assigneeName}`);
    }
  }

  if (payload.status) {
    if (!canTransition(row.status, payload.status)) {
      return fail(
        'VALIDATION',
        `transição inválida: ${row.status} → ${payload.status}`,
        `"${row.title}" está como ${row.status} e não dá para mudar direto para ${payload.status}.`,
      );
    }
    patch['status'] = payload.status;
    // O CHECK do schema exige que done e completed_at andem juntos.
    patch['completed_at'] = payload.status === 'done' ? new Date().toISOString() : null;
    changes.push(`status para ${payload.status}`);
  }

  if (Object.keys(patch).length === 0) {
    return fail('VALIDATION', 'nada para alterar', 'Não entendi o que mudar nessa tarefa.');
  }

  const { error } = await supabase.from('tasks').update(patch).eq('id', row.id);
  if (error) return fail('DB', error.message, 'Não consegui alterar essa tarefa.');

  return {
    success: true,
    data: { taskId: row.id },
    summaryForOrchestrator: `Tarefa "${row.title}" atualizada: ${changes.join(', ')}.`,
    touched: ['tasks'],
  };
}

async function complete(
  supabase: Supabase,
  payload: { task: string },
  today: IsoDate,
): Promise<AgentResponse> {
  const resolved = await resolveTask(supabase, payload.task, today);
  if ('error' in resolved) return resolved.error;

  const row = resolved.row;

  if (row.status === 'done') {
    return {
      success: true,
      data: { taskId: row.id, alreadyDone: true },
      summaryForOrchestrator: `"${row.title}" já estava concluída.`,
    };
  }

  if (!canTransition(row.status, 'done')) {
    return fail(
      'VALIDATION',
      `transição inválida: ${row.status} → done`,
      `"${row.title}" foi cancelada. Quer reabrir antes de marcar como feita?`,
    );
  }

  const { error } = await supabase
    .from('tasks')
    .update({ status: 'done', completed_at: new Date().toISOString() })
    .eq('id', row.id);

  if (error) return fail('DB', error.message, 'Não consegui concluir essa tarefa.');

  return {
    success: true,
    data: { taskId: row.id },
    summaryForOrchestrator: `Tarefa "${row.title}" concluída.`,
    blocks: [{ type: 'task_card', taskId: row.id, title: row.title, dueDate: row.due_date }],
    touched: ['tasks'],
  };
}

async function remove(
  supabase: Supabase,
  payload: { task: string },
  today: IsoDate,
): Promise<AgentResponse> {
  const resolved = await resolveTask(supabase, payload.task, today);
  if ('error' in resolved) return resolved.error;

  const row = resolved.row;

  // DELETE de verdade: uma tarefa apagada não é histórico financeiro, é ruído.
  const { error } = await supabase.from('tasks').delete().eq('id', row.id);
  if (error) return fail('DB', error.message, 'Não consegui apagar essa tarefa.');

  return {
    success: true,
    data: { taskId: row.id },
    summaryForOrchestrator: `Tarefa "${row.title}" apagada.`,
    touched: ['tasks'],
  };
}
