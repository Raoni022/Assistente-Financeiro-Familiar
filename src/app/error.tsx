'use client';

/**
 * Fronteira de erro de página.
 *
 * Sem isto, uma exceção em Server Component vira 500 cru com "Minified React
 * error #441" no console — que em produção significa literalmente "deu erro no
 * render, a mensagem foi omitida". Ninguém consegue agir sobre isso.
 *
 * O `digest` é a única ponte entre o que a pessoa vê na tela e a stack trace
 * real nos logs da Vercel (Project → Logs, procure pelo mesmo digest). Por isso
 * ele aparece aqui: não é enfeite, é o identificador que torna o erro
 * rastreável sem expor detalhe sensível.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center px-5">
      <h1 className="text-[22px] font-semibold">Algo quebrou aqui</h1>
      <p className="mt-2 text-[15px] text-dim">
        Não foi você — foi o sistema. O erro já está registrado nos logs.
      </p>

      {error.digest && (
        <p className="mt-4 rounded-item border border-line bg-surface px-3 py-2 text-[13px] text-dim">
          Código do erro: <span className="money text-text">{error.digest}</span>
        </p>
      )}

      <button
        type="button"
        onClick={reset}
        className="mt-6 w-full rounded-item bg-accent px-4 py-3 text-[15px] font-medium text-accent-ink"
      >
        Tentar de novo
      </button>
    </main>
  );
}
