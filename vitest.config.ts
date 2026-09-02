import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@tests': fileURLToPath(new URL('./tests', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    // tests/unit é determinístico e sem rede — é o que roda no CI.
    // tests/eval chama modelo e custa dinheiro: só sob demanda (`npm run eval`).
    // tests/rls precisa de um Supabase alcançável (`npm run test:rls`).
    include: ['**/*.test.ts'],
  },
});
