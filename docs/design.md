# Plano de design — Assistente Financeiro Familiar

Revisar **antes** de escrever componentes (seção 4.3 do brief). Nada aqui é decorativo por decoração:
cada escolha abaixo tem uma justificativa ou é um trade-off declarado.

---

## 1. Cor

### Accent: `#C9A876` (dourado sóbrio) — escolhido

O brief pedia um só. A decisão é dourado, por três motivos concretos:

1. **Contraste.** Botão primário preenchido de dourado com tinta escura (`#0E0F13`) dá **8.5:1** —
   passa AAA folgado. O azul `#5B7FFF` preenchido com texto branco dá **3.5:1** e reprova em AA para
   texto normal; funcionaria só com tinta escura (5.4:1), o que fica visualmente estranho num azul
   saturado. O dourado resolve o botão primário sem malabarismo.
2. **Não colide com semântica.** `positive` e `negative` já carregam significado direcional. Dourado
   nunca é lido como "subiu" ou "caiu" — é inequivocamente marca/ação. Azul-índigo é o accent padrão
   de todo dashboard escuro gerado por IA nos últimos dois anos; é exatamente o clichê que o brief
   pede para evitar, só que na versão fria em vez da versão verde-ácido.
3. **Casa com o fundo.** `#0E0F13` tem viés azulado. Um accent quente sobre base fria cria separação
   real de plano; azul sobre azul-escuro achata.

**Contra-argumento honesto:** dourado carrega leitura de *private banking* / gestão de patrimônio,
que é um registro mais formal do que "app da família". Se ao ver o shell isso soar pomposo, a troca é
uma linha em `tokens.css` — nenhum componente referencia hex direto.

### Tokens

| Token | Hex | Uso | Contraste vs base |
|---|---|---|---|
| `--bg` | `#0E0F13` | fundo base | — |
| `--surface` | `#171922` | cards, painel do chat | — |
| `--surface-raised` | `#1F212C` | modais, dropdowns, bolha do assistente | — |
| `--border` | `#2A2D3A` | divisória **decorativa** (1.3:1) | não usar para nada que precise ser percebido |
| `--border-strong` | `#626880` | borda de input, foco, limite interativo | 3.2:1 vs surface ✓ |
| `--text` | `#F2F3F7` | texto principal | 16.9:1 ✓ |
| `--text-dim` | `#8B8FA3` | labels, metadados | 6.0:1 vs bg / 5.5:1 vs surface ✓ |
| `--accent` | `#C9A876` | ação primária, valor em destaque | 8.5:1 ✓ |
| `--accent-ink` | `#0E0F13` | tinta sobre accent preenchido | 8.5:1 ✓ |
| `--positive` | `#3DD68C` | economia, saldo positivo | 10.2:1 ✓ |
| `--negative` | `#FF6B6B` | vencida, gasto acima do esperado | 6.9:1 ✓ |

Adicionados ao brief: `--border-strong` e `--accent-ink`. Motivo do primeiro: `#2A2D3A` sobre
`#171922` é 1.3:1 — ótimo como divisória sutil, **insuficiente** para a borda de um campo de texto ou
um anel de foco, que precisam de 3:1. Sem esse token, ou o foco fica invisível ou alguém acaba
enfiando uma borda branca e quebrando o "nunca branco puro" do brief.

### Proibido

- Verde-ácido / neon como accent.
- Gradiente que não represente dado (aceito só em preenchimento de barra de progresso de orçamento).
- `box-shadow` cinza translúcido genérico em todo card. Elevação vem de **degrau de superfície +
  borda de 1px**. Sombra real existe em exatamente dois lugares: o painel de chat flutuante e o FAB.
- Cor como único portador de informação. Vencida = vermelho **e** ícone **e** a palavra "vencida".

---

## 2. Tipografia

**Geist Sans, uma só família, auto-hospedada** via o pacote `geist` + `next/font`.

Por que Geist e não Inter: numerais tabulares de qualidade por padrão, desenho mais neutro nos pesos
altos (Inter fica levemente "tech-startup" em 700), e — o argumento decisivo — `next/font` a
auto-hospeda, então **um app financeiro não faz request para `fonts.gstatic.com` a cada visita**.
Zero third-party no caminho de render.

| Papel | Tamanho / peso | Observação |
|---|---|---|
| Saldo do mês (herói) | 40px / 600 | único 600 grande da tela |
| Valor em card de lista | 16px / 500, `tabular-nums` | alinha em coluna |
| Título de seção | 13px / 500, `letter-spacing: .04em`, `--text-dim`, caixa alta | hierarquia por peso+cor, não por tamanho grande |
| Corpo / mensagem de chat | 15px / 400, `line-height: 1.55` | |
| Label / metadado | 13px / 400, `--text-dim` | |
| Numeral monetário | sempre `font-variant-numeric: tabular-nums` | via classe `.money`, nunca ad hoc |

Hierarquia é feita por **peso + cor + espaço**, nunca por tamanho aleatório. A tela inteira usa 5
tamanhos: 13 / 15 / 16 / 22 / 40.

---

## 3. Forma e espaço

**Raio deliberadamente não uniforme** — é o que dá peso visual diferente:

| Elemento | Raio |
|---|---|
| Card de saldo (herói) | 20px |
| Card de seção / lista | 14px |
| Item dentro de lista, chip, bolha de chat | 10px |
| Botão | 10px · FAB: círculo |
| Bottom sheet do chat (mobile) | 20px só no topo |

Escala de espaço: `4 · 8 · 12 · 16 · 24 · 32 · 48`. Padding de card: 16 no mobile, 20 no desktop.
Gap entre cards: 12. Respiro vertical entre seções: 24.

---

## 4. Layout

Mobile é a plataforma; desktop é adaptação.

### 4.1 Dashboard — mobile (390px)

```
┌────────────────────────────────────────┐
│  Setembro                    ⚙︎  RM     │  header, 56px, sem borda
│                                        │
│ ┌────────────────────────────────────┐ │
│ │ GASTO NO MÊS                       │ │  r=20  ← card herói
│ │                                    │ │
│ │ R$ 3.482,90                        │ │  40/600, tabular
│ │ ▁▂▃▅▇ 68% do previsto              │ │  barra fina, accent
│ │                                    │ │
│ │  a pagar        pago        sobra  │ │  13/400 dim
│ │  R$ 1.240      R$ 2.242    R$ 517  │ │  16/500 tabular
│ └────────────────────────────────────┘ │
│                                        │
│  PRÓXIMOS VENCIMENTOS                  │  13/500 caps dim
│ ┌────────────────────────────────────┐ │
│ │ ● Energia            R$ 340,00     │ │  r=14, itens r=10
│ │   vence em 3 dias · Raoni          │ │  ● = accent
│ │ ─────────────────────────────────  │ │  divisória --border
│ │ ● Internet           R$ 129,90     │ │
│ │   vence em 6 dias · Casa           │ │
│ │ ─────────────────────────────────  │ │
│ │ ▲ Cartão            R$ 1.204,00    │ │  ▲ + vermelho + "vencida"
│ │   vencida há 2 dias · Raoni        │ │
│ │                                    │ │
│ │ ver todas (6)                      │ │  link, --text-dim
│ └────────────────────────────────────┘ │
│                                        │
│  ÚLTIMOS GASTOS                        │
│ ┌────────────────────────────────────┐ │
│ │ Mercado              R$ 218,40  ⌄  │ │
│ │ ontem · Camila                     │ │
│ │ ─────────────────────────────────  │ │
│ │ Delivery              R$ 64,90     │ │
│ │ ontem · Raoni                      │ │
│ └────────────────────────────────────┘ │
│                                        │
│ ┌────────────────────────────────────┐ │
│ │ ✦ Delivery subiu 34% vs. a média   │ │  card de insight
│ │   dos últimos 3 meses.             │ │  só aparece se existir
│ │   R$ 486 · média R$ 362      →     │ │  dado de suporte
│ └────────────────────────────────────┘ │
│                                   ╭──╮ │
│                                   │ ✧│ │  FAB 56px, accent
└───────────────────────────────────╰──╯─┘  sombra + glow dourado
```

### 4.2 Chat aberto — mobile (bottom sheet, 85vh)

O dashboard **continua visível** atrás, escurecido (`rgba(14,15,19,.6)` + `backdrop-blur(2px)`).
Nunca navega para outra tela.

```
┌────────────────────────────────────────┐
│  Setembro                    ⚙︎  RM     │  ← dashboard atrás,
│ ┌────────────────────────────────────┐ │     escurecido
│ │ GASTO NO MÊS         R$ 3.482,90   │ │
├─╰────────────────────────────────────╯─┤
│              ────                      │  handle de arraste
│  Assistente                        ✕   │
│ ┌────────────────────────────────────┐ │
│ │                                    │ │
│ │              ┌───────────────────┐ │ │
│ │              │ gastei 80 no      │ │ │  usuário: accent
│ │              │ mercado hoje      │ │ │  sutil, r=10
│ │              └───────────────────┘ │ │
│ │                                    │ │
│ │ ┌────────────────────────────────┐ │ │
│ │ │ Registrei R$ 80,00 em Mercado, │ │ │  assistente:
│ │ │ hoje, no seu nome.             │ │ │  --surface-raised
│ │ │ ┌────────────────────────────┐ │ │ │
│ │ │ │ Mercado    R$ 80,00     ✎  │ │ │ │  ← UiBlock inline
│ │ │ │ 02/09 · Raoni              │ │ │ │     (bloco visual,
│ │ │ └────────────────────────────┘ │ │ │      não só texto)
│ │ │ Mercado no mês: R$ 298,40      │ │ │
│ │ └────────────────────────────────┘ │ │
│ └────────────────────────────────────┘ │
│ ┌────────────────────────────────────┐ │
│ │ Escreva…                        ➤  │ │  input, --border-strong
│ └────────────────────────────────────┘ │
└────────────────────────────────────────┘
```

Ao fechar, o valor "GASTO NO MÊS" no dashboard já está atualizado, com o pulso descrito na seção 5.

### 4.3 Desktop (≥1024px)

Não é o mobile esticado nem um layout novo. Duas colunas para o dashboard (herói ocupando a largura
inteira, depois vencimentos | gastos lado a lado), e o chat vira **painel lateral direito fixo de
400px** que desliza sobre o conteúdo — mesmo componente, mesma máquina de estados, só a apresentação
muda por media query.

```
┌──────────────────────────────────────────────────────────┬──────────────────┐
│  Setembro                                     ⚙︎   RM     │  Assistente   ✕  │
│ ┌──────────────────────────────────────────────────────┐ │                  │
│ │ GASTO NO MÊS   R$ 3.482,90   ▁▂▃▅▇ 68% do previsto   │ │      ┌─────────┐ │
│ └──────────────────────────────────────────────────────┘ │      │ gastei… │ │
│ ┌───────────────────────────┐ ┌────────────────────────┐ │      └─────────┘ │
│ │ PRÓXIMOS VENCIMENTOS      │ │ ÚLTIMOS GASTOS         │ │ ┌──────────────┐ │
│ │ ● Energia      R$ 340,00  │ │ Mercado    R$ 218,40   │ │ │ Registrei…   │ │
│ │ ● Internet     R$ 129,90  │ │ Delivery    R$ 64,90   │ │ │ ┌──────────┐ │ │
│ │ ▲ Cartão     R$ 1.204,00  │ │ Farmácia    R$ 92,10   │ │ │ │ card     │ │ │
│ └───────────────────────────┘ └────────────────────────┘ │ │ └──────────┘ │ │
│ ┌──────────────────────────────────────────────────────┐ │ └──────────────┘ │
│ │ ✦ Delivery subiu 34% vs. a média dos últimos 3 meses │ │ ┌──────────────┐ │
│ └──────────────────────────────────────────────────────┘ │ │ Escreva…  ➤  │ │
└──────────────────────────────────────────────────────────┴─└──────────────┘─┘
```

---

## 5. Movimento

Pouco, e sempre com função.

| O quê | Como | Duração |
|---|---|---|
| Chat abre/fecha (mobile) | `translateY` + opacity do backdrop | 260ms `cubic-bezier(.32,.72,0,1)` |
| Chat abre/fecha (desktop) | `translateX` do painel | 220ms, mesma curva |
| Valor muda após ação do agente | flash de fundo a 12% de `--positive`/`--negative` atrás do número, sem mexer no layout | 600ms ease-out |
| Resposta do agente | streaming de texto | nativo, sem animação extra |

**Não existe:** entrada escalonada de cards ao carregar, `fade-in-up` genérico, skeleton pulsante em
tudo. Carregamento inicial mostra o valor real ou um traço `—`, não um esqueleto animado.

`@media (prefers-reduced-motion: reduce)` reduz tudo a troca de opacidade em 1ms e elimina o pulso.

---

## 6. "Ao vivo" — como o dashboard reflete o chat

Este é o ponto que separa "um app" de "dois apps colados", então merece ser explícito:

1. O agente escreve no banco e devolve `touched: [{ resource: 'transactions' }, ...]` no
   `AgentResponse`.
2. A rota de chat inclui `touched` no fim do stream.
3. O cliente invalida **só** as queries afetadas e faz refetch.
4. O componente de valor compara o novo valor com o anterior e dispara o pulso.

Supabase Realtime fica como reforço para quando *outra pessoa da casa* registra algo — mas o caminho
principal é o `touched`, porque é síncrono com a resposta e não depende de websocket estar de pé.

---

## 7. Acessibilidade — mínimo aceito

- Texto: 4.5:1. Limites interativos e anel de foco: 3:1 (daí `--border-strong`).
- Anel de foco visível em `--accent` (7.8:1 sobre surface), nunca `outline: none` sem substituto.
- Alvo de toque mínimo 44×44 — inclui o `✎` de editar transação no chat.
- Estado nunca só por cor (ver seção 1).
- Bottom sheet: foco preso enquanto aberto, `Esc` fecha, foco volta ao FAB.
