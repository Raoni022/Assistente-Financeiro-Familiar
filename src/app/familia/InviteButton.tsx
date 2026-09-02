'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { createInvite, type InviteState } from './actions';

const INITIAL: InviteState = { status: 'idle' };

export function InviteButton() {
  const [state, action] = useActionState(createInvite, INITIAL);

  return (
    <form action={action} className="space-y-3">
      {state.status === 'created' && state.code && (
        <div className="rounded-item border border-line bg-raised p-4">
          <p className="text-[13px] text-dim">Código do convite — vale 7 dias</p>
          <p className="money mt-1 text-[22px] font-semibold tracking-[0.18em]">{state.code}</p>
        </div>
      )}
      {state.status === 'error' && (
        <p role="alert" className="text-[13px] text-negative">
          {state.message}
        </p>
      )}
      <Submit hasCode={state.status === 'created'} />
    </form>
  );
}

function Submit({ hasCode }: { hasCode: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="w-full rounded-item border border-line-strong px-4 py-3 text-[15px] font-medium transition-opacity disabled:opacity-60"
    >
      {pending ? 'Gerando…' : hasCode ? 'Gerar outro código' : 'Convidar alguém'}
    </button>
  );
}
