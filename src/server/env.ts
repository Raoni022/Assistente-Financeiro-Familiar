import 'server-only';
import { z } from 'zod';

/**
 * Validação de env var no boot do servidor. Falhar aqui, com nome da variável
 * faltando, é muito melhor do que descobrir em runtime que uma chave é
 * `undefined` no meio de uma chamada ao modelo.
 *
 * `VOYAGE_API_KEY` é opcional até a Fase 5 (memória semântica).
 */
const schema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(20),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),
  ANTHROPIC_API_KEY: z.string().min(20).optional(),
  VOYAGE_API_KEY: z.string().min(20).optional(),
});

let cached: z.infer<typeof schema> | null = null;

export function env(): z.infer<typeof schema> {
  if (cached) return cached;

  const parsed = schema.safeParse({
    NEXT_PUBLIC_SUPABASE_URL: process.env['NEXT_PUBLIC_SUPABASE_URL'],
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY'],
    SUPABASE_SERVICE_ROLE_KEY: process.env['SUPABASE_SERVICE_ROLE_KEY'],
    ANTHROPIC_API_KEY: process.env['ANTHROPIC_API_KEY'],
    VOYAGE_API_KEY: process.env['VOYAGE_API_KEY'],
  });

  if (!parsed.success) {
    const missing = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
    // A mensagem cita apenas NOMES de variável. Nunca valores.
    throw new Error(
      `Variáveis de ambiente inválidas ou ausentes: ${missing}. Veja .env.example.`,
    );
  }

  cached = parsed.data;
  return cached;
}
