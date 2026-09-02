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

  if (error || !profile) return null;

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
