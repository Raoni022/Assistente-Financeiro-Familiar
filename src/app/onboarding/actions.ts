'use server';

import { redirect } from 'next/navigation';
import { z } from 'zod';
import { getSession } from '@/server/auth/session';
import { createAdminClient } from '@/server/db/admin';

/**
 * Onboarding é o único fluxo do app que usa service role para escrever em
 * `profiles` e `households`. Motivo: antes de existir um profile,
 * `current_household_id()` é NULL e toda policy nega — não há como o próprio
 * usuário se inserir sem abrir uma policy de INSERT que seria mais perigosa do
 * que este caminho controlado.
 *
 * Regra de ouro aqui: o `id` do profile vem SEMPRE da sessão validada, nunca do
 * formulário. Sem isso, service role + input do usuário = criar perfil alheio.
 */

const DisplayName = z
  .string()
  .trim()
  .min(1, 'Diga como quer ser chamado.')
  .max(60, 'Nome muito longo.');

const CreateInput = z.object({
  householdName: z.string().trim().min(1, 'Dê um nome para a casa.').max(80),
  displayName: DisplayName,
});

const JoinInput = z.object({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9]{8}$/, 'O código tem 8 caracteres.'),
  displayName: DisplayName,
});

export interface OnboardingState {
  status: 'idle' | 'error';
  message?: string;
}

export async function createHousehold(
  _prev: OnboardingState,
  formData: FormData,
): Promise<OnboardingState> {
  const session = await getSession();
  if (!session) redirect('/login');
  if (session.householdId) redirect('/');

  const parsed = CreateInput.safeParse({
    householdName: formData.get('householdName'),
    displayName: formData.get('displayName'),
  });
  if (!parsed.success) {
    return { status: 'error', message: parsed.error.issues[0]?.message ?? 'Dados inválidos.' };
  }

  const admin = createAdminClient();

  const { data: household, error: householdError } = await admin
    .from('households')
    .insert({ name: parsed.data.householdName })
    .select('id')
    .single();

  if (householdError || !household) {
    console.error('[onboarding] criar household falhou:', householdError?.message);
    return { status: 'error', message: 'Não consegui criar a casa agora. Tente de novo.' };
  }

  const { error: profileError } = await admin.from('profiles').insert({
    id: session.userId, // da sessão validada, jamais do formulário
    household_id: household.id,
    display_name: parsed.data.displayName,
    role: 'admin',
  });

  if (profileError) {
    console.error('[onboarding] criar profile falhou:', profileError.message);
    // Household órfão sem dono é lixo: desfaz para não acumular.
    await admin.from('households').delete().eq('id', household.id);
    return { status: 'error', message: 'Não consegui concluir o cadastro. Tente de novo.' };
  }

  redirect('/');
}

export async function joinHousehold(
  _prev: OnboardingState,
  formData: FormData,
): Promise<OnboardingState> {
  const session = await getSession();
  if (!session) redirect('/login');
  if (session.householdId) redirect('/');

  const parsed = JoinInput.safeParse({
    code: formData.get('code'),
    displayName: formData.get('displayName'),
  });
  if (!parsed.success) {
    return { status: 'error', message: parsed.error.issues[0]?.message ?? 'Dados inválidos.' };
  }

  const admin = createAdminClient();

  const { data: invite } = await admin
    .from('household_invites')
    .select('code, household_id, expires_at, used_by')
    .eq('code', parsed.data.code)
    .maybeSingle();

  // Mensagem idêntica para código inexistente, expirado e já usado — não vale
  // entregar a um estranho a informação de que um código existe.
  const invalid: OnboardingState = { status: 'error', message: 'Código inválido ou expirado.' };
  if (!invite) return invalid;
  if (invite.used_by) return invalid;
  if (new Date(invite.expires_at as string) < new Date()) return invalid;

  const { error: profileError } = await admin.from('profiles').insert({
    id: session.userId,
    household_id: invite.household_id,
    display_name: parsed.data.displayName,
    role: 'member',
  });

  if (profileError) {
    console.error('[onboarding] entrar em household falhou:', profileError.message);
    return { status: 'error', message: 'Não consegui concluir o cadastro. Tente de novo.' };
  }

  // Marca o convite como usado só depois do profile criado. Na ordem inversa,
  // uma falha ali queimaria o código sem ninguém ter entrado.
  await admin
    .from('household_invites')
    .update({ used_by: session.userId, used_at: new Date().toISOString() })
    .eq('code', invite.code);

  redirect('/');
}
