import Link from 'next/link';
import { Card, SectionTitle } from '@/components/ui/Card';
import { requireHousehold } from '@/server/auth/session';
import { createClient } from '@/server/db/server';
import { getMembers } from '@/server/db/queries/dashboard';
import { InviteButton } from './InviteButton';
import { signOut } from './actions';

export const dynamic = 'force-dynamic';

export default async function FamiliaPage() {
  const session = await requireHousehold();
  const supabase = await createClient();

  const [{ data: household }, members] = await Promise.all([
    supabase.from('households').select('name').eq('id', session.householdId).maybeSingle(),
    getMembers(supabase),
  ]);

  return (
    <main className="mx-auto min-h-dvh w-full max-w-md px-4 pb-12">
      <header className="flex h-14 items-center justify-between">
        <Link href="/" className="text-[15px] text-dim">
          ← Voltar
        </Link>
      </header>

      <h1 className="mb-6 text-[22px] font-semibold">{(household?.name as string) ?? 'Sua casa'}</h1>

      <section className="mb-6">
        <SectionTitle>Quem está aqui</SectionTitle>
        <Card>
          <ul>
            {[...members.values()].map((member, index) => (
              <li
                key={member.id}
                className={`flex items-center justify-between ${
                  index > 0 ? 'mt-3 border-t border-line pt-3' : ''
                }`}
              >
                <span className="text-[15px]">{member.displayName}</span>
                <span className="text-[13px] text-dim">
                  {member.role === 'admin' ? 'admin' : 'membro'}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      </section>

      {session.role === 'admin' && (
        <section className="mb-6">
          <SectionTitle>Convidar</SectionTitle>
          <InviteButton />
        </section>
      )}

      <form action={signOut}>
        <button type="submit" className="text-[13px] text-dim underline-offset-4 hover:underline">
          Sair desta conta
        </button>
      </form>
    </main>
  );
}
