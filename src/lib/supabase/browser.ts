import { createBrowserClient } from '@supabase/ssr';

/**
 * Cliente do navegador. Usa APENAS a anon key, que é pública por desenho — a
 * proteção real é a RLS no banco, não o segredo da chave.
 *
 * Este é o único módulo Supabase que pode ser importado por client component.
 * Todo o resto vive em src/server/db/, atrás de `server-only`.
 */
export function createClient() {
  return createBrowserClient(
    process.env['NEXT_PUBLIC_SUPABASE_URL']!,
    process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY']!,
  );
}
