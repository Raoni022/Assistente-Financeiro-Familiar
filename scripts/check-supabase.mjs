#!/usr/bin/env node
/**
 * Smoke test do setup do Supabase. Roda depois de aplicar a migração:
 *
 *   npm run db:check
 *
 * Verifica quatro coisas, nesta ordem de importância:
 *   1. as credenciais funcionam;
 *   2. todas as tabelas da migração existem;
 *   3. a extensão vector e a RPC match_memories existem;
 *   4. a RLS está de fato ligada — um cliente anônimo não pode ler nada.
 *
 * O item 4 é o que importa. Uma tabela sem policy retorna dado para qualquer um
 * com a anon key, que é pública por desenho. Se este script disser que está tudo
 * certo e a RLS estiver desligada, ele não serviu para nada.
 */

import { createClient } from '@supabase/supabase-js';
import './load-env.mjs';

const TABLES = [
  'households',
  'profiles',
  'household_invites',
  'categories',
  'bills',
  'bill_occurrences',
  'transactions',
  'transaction_corrections',
  'tasks',
  'memories',
  'conversations',
  'messages',
  'agent_runs',
  'notifications',
  'notification_preferences',
  'rate_limits',
];

const ok = (msg) => console.log(`  \x1b[32m✓\x1b[0m ${msg}`);
const bad = (msg) => console.log(`  \x1b[31m✗\x1b[0m ${msg}`);
const warn = (msg) => console.log(`  \x1b[33m!\x1b[0m ${msg}`);

let failures = 0;
const fail = (msg) => {
  failures += 1;
  bad(msg);
};

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

console.log('\nVerificando o Supabase configurado em .env.local\n');

if (!url || !anonKey || !serviceKey) {
  bad('Faltam variáveis em .env.local.');
  console.log('    Preencha NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY');
  console.log('    e SUPABASE_SERVICE_ROLE_KEY. Veja .env.example.\n');
  process.exit(1);
}

if (url.includes('placeholder')) {
  bad('NEXT_PUBLIC_SUPABASE_URL ainda é o valor fictício do scaffold.');
  console.log('    Substitua pelos dados do seu projeto real.\n');
  process.exit(1);
}

const opts = { auth: { autoRefreshToken: false, persistSession: false } };
const admin = createClient(url, serviceKey, opts);
const anon = createClient(url, anonKey, opts);

// --- 1. conectividade -------------------------------------------------------
console.log('Conectividade');
{
  const { error } = await admin.from('households').select('id').limit(1);
  if (error && error.code === '42P01') {
    fail('Conectou, mas a tabela `households` não existe — a migração não rodou.');
    console.log('\n    Rode supabase/migrations/0001_init.sql no SQL Editor e tente de novo.\n');
    process.exit(1);
  } else if (error) {
    fail(`Não consegui consultar: ${error.message}`);
    console.log('\n    Confira URL e service_role key em Project Settings → API.\n');
    process.exit(1);
  }
  ok(`conectado em ${new URL(url).host}`);
}

// --- 2. tabelas -------------------------------------------------------------
console.log('\nTabelas da migração');
{
  const missing = [];
  for (const table of TABLES) {
    const { error } = await admin.from(table).select('*').limit(1);
    if (error?.code === '42P01') missing.push(table);
    else if (error) warn(`${table}: ${error.message}`);
  }
  if (missing.length) fail(`faltando: ${missing.join(', ')}`);
  else ok(`${TABLES.length} tabelas presentes`);
}

// --- 3. categorias semeadas -------------------------------------------------
{
  const { count, error } = await admin
    .from('categories')
    .select('*', { count: 'exact', head: true })
    .is('household_id', null);
  if (error) warn(`não consegui contar categorias: ${error.message}`);
  else if ((count ?? 0) < 20) fail(`só ${count} categorias globais — o seed não rodou por inteiro`);
  else ok(`${count} categorias globais semeadas`);
}

// --- 4. pgvector e a RPC de busca semântica ---------------------------------
console.log('\npgvector');
{
  const { error } = await admin.rpc('match_memories', {
    query_embedding: Array.from({ length: 1024 }, () => 0),
    match_count: 1,
    min_similarity: 0,
  });
  if (error?.code === 'PGRST202') {
    fail('a função match_memories não existe — a migração rodou parcialmente.');
  } else if (error) {
    warn(`match_memories respondeu com erro: ${error.message}`);
  } else {
    ok('extensão vector ativa e match_memories responde');
  }
}

// --- 5. RLS: o teste que realmente importa ----------------------------------
console.log('\nRLS (cliente anônimo, sem sessão — não deve ler nada)');
{
  const leaked = [];
  for (const table of TABLES) {
    const { data, error } = await anon.from(table).select('*').limit(1);
    // Erro é ótimo aqui: significa negado. Dado retornado é que é problema.
    if (!error && data && data.length > 0) leaked.push(table);
  }
  if (leaked.length) {
    fail(`VAZANDO com a anon key: ${leaked.join(', ')}`);
    console.log('    A anon key é pública por desenho. Estas tabelas estão abertas');
    console.log('    para qualquer pessoa. Confira o bloco de RLS em 0001_init.sql.');
  } else {
    ok('nenhuma tabela retorna dado sem autenticação');
  }
}

console.log('');
if (failures > 0) {
  console.log(`\x1b[31m${failures} problema(s).\x1b[0m Corrija antes de seguir.\n`);
  process.exit(1);
}
console.log('\x1b[32mSetup do Supabase válido.\x1b[0m Próximo passo: npm run test:rls\n');
