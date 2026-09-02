'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { requestMagicLink, type LoginState } from './actions';

const INITIAL: LoginState = { status: 'idle' };

export function LoginForm() {
  const [state, action] = useActionState(requestMagicLink, INITIAL);

  if (state.status === 'sent') {
    return (
      <div className="rounded-card border border-line bg-surface p-5">
        <p className="text-[15px]">Link enviado.</p>
        <p className="mt-2 text-[13px] text-dim">
          Abra o e-mail e toque no link para entrar. Ele vale por uma hora.
        </p>
      </div>
    );
  }

  return (
    <form action={action} className="space-y-3">
      <label htmlFor="email" className="block text-[13px] text-dim">
        E-mail
      </label>
      <input
        id="email"
        name="email"
        type="email"
        autoComplete="email"
        required
        placeholder="voce@exemplo.com"
        className="w-full rounded-item border border-line-strong bg-surface px-3 py-3 text-[15px] outline-none placeholder:text-dim focus-visible:border-accent"
      />
      {state.status === 'error' && (
        <p role="alert" className="text-[13px] text-negative">
          {state.message}
        </p>
      )}
      <SubmitButton />
    </form>
  );
}

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="w-full rounded-item bg-accent px-4 py-3 text-[15px] font-medium text-accent-ink transition-opacity disabled:opacity-60"
    >
      {pending ? 'Enviando…' : 'Receber link de acesso'}
    </button>
  );
}
