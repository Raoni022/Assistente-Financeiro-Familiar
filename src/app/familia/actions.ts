'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireHousehold } from '@/server/auth/session';
import { createClient } from '@/server/db/server';

/** Sem I, O, 0 e 1: alguém vai ler este código em voz alta pelo telefone. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
}

export interface InviteState {
  status: 'idle' | 'created' | 'error';
  code?: string;
  message?: string;
}

/**
 * Cria um convite. Usa o cliente com JWT do usuário de propósito: a policy
 * `invites_insert` já exige `is_household_admin()`, então a autorização é
 * verificada pelo banco, não por um `if` na aplicação.
 */
export async function createInvite(_prev: InviteState): Promise<InviteState> {
  await requireHousehold();
  const supabase = await createClient();

  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  // Colisão de código é improvável (32^8), mas não impossível: a PK é que
  // decide, e uma segunda tentativa resolve.
  for (let attempt = 0; attempt < 3; attempt++) {
    const code = generateCode();
    const { error } = await supabase.from('household_invites').insert({ code, expires_at: expiresAt });

    if (!error) {
      revalidatePath('/familia');
      return { status: 'created', code };
    }
    if (error.code !== '23505') {
      console.error('[familia] criar convite falhou:', error.message);
      return { status: 'error', message: 'Não consegui gerar o convite. Você é admin da casa?' };
    }
  }

  return { status: 'error', message: 'Não consegui gerar um código único. Tente de novo.' };
}

export async function signOut(): Promise<void> {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect('/login');
}
