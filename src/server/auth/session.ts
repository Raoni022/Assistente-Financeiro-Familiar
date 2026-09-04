import 'server-only';
import { redirect } from 'next/navigation';
import { cache } from 'react';
import { createClient } from '@/server/db/server';
import type { HouseholdRole } from '@/lib/types';

/**
 * Identidade resolvida no servidor. O `householdId` daqui é o ÚNICO que pode
 * entrar num `AgentContext` — nunca o que vem do body de uma request.
 */
export interface Session {
  userId: string;
  email: string;
  displayName: string;
  role: HouseholdRole;
  /** Null enquanto a pessoa não entrou nem criou um household. */
  householdId: string | null;
  /** Fuso da família. Toda resolução de "hoje" parte daqui. */
  timezone: string;
}

/**
 * `cache` do React deduplica na mesma request: layout, página e Server Action
 * chamam à vontade sem multiplicar round-trip.
 */
export const getSession = cache(async (): Promise<Session | null> => {
  const supabase = await createClient();

  // getUser() valida o JWT no servidor Supabase. getSession() lê o cookie sem
  // validar — não serve para decisão de autorização.
  const { data: auth, error: authError } = await supabase.auth.getUser();
  if (authError || !auth.user) return null;

  const { data: profile, error } = await supabase
    .from('profiles')
    .select('id, display_name, role, household_id')
    .eq('id', auth.user.id)
    .maybeSingle();

  if (error) {
    // Falha real de banco. Logar é obrigatório: sem isso, um Postgres fora do
    // ar fica idêntico a "não está logado", e o usuário só vê a tela de login
    // reaparecendo sem explicação nenhuma.
    console.error('[session] falha ao ler profile:', error.message);
    return null;
  }

  /*
   * Autenticado, mas ainda sem linha em `profiles`. Isso NÃO é "sem sessão" —
   * é exatamente o estado de quem acabou de criar a conta e ainda não passou
   * pelo onboarding, que é justamente quem cria o profile.
   *
   * Devolver null aqui criava um deadlock: /onboarding exige sessão, a sessão
   * exige profile, e o profile só nasce dentro do /onboarding. A pessoa
   * logava com a senha certa e voltava para o login, para sempre. Foi o que
   * quebrou tanto o fluxo de magic link quanto o de senha.
   */
  if (!profile) {
    return {
      userId: auth.user.id,
      email: auth.user.email ?? '',
      // Placeholder de vida curta: a primeira coisa que o onboarding pede é o
      // nome de verdade.
      displayName: auth.user.email?.split('@')[0] ?? 'você',
      role: 'member',
      householdId: null,
      timezone: 'America/Sao_Paulo',
    };
  }

  const householdId = (profile.household_id as string | null) ?? null;

  // Query separada em vez de embed `households ( timezone )`: para uma relação
  // to-one o PostgREST devolve objeto, mas sem tipos gerados a inferência do
  // supabase-js entrega array, e o cast necessário para conciliar os dois
  // esconderia um erro real se a forma mudasse. Duas queries deduplicadas pelo
  // `cache` do React custam menos que esse risco.
  let timezone = 'America/Sao_Paulo';
  if (householdId) {
    const { data: household } = await supabase
      .from('households')
      .select('timezone')
      .eq('id', householdId)
      .maybeSingle();
    if (household?.timezone) timezone = household.timezone as string;
  }

  return {
    userId: profile.id as string,
    email: auth.user.email ?? '',
    displayName: profile.display_name as string,
    role: profile.role as HouseholdRole,
    householdId,
    timezone,
  };
});

/** Exige login. Redireciona para /login se não houver sessão. */
export async function requireSession(): Promise<Session> {
  const session = await getSession();
  if (!session) redirect('/login');
  return session;
}

/**
 * Exige login E household. É o que quase toda página usa: sem household,
 * `current_household_id()` é NULL e toda policy nega — a pessoa veria um app
 * vazio sem entender por quê.
 */
export async function requireHousehold(): Promise<Session & { householdId: string }> {
  const session = await requireSession();
  if (!session.householdId) redirect('/onboarding');
  return session as Session & { householdId: string };
}
