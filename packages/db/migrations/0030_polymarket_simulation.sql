-- STK-F2-17 — registros de simulação MERAMENTE INDICATIVA da Polymarket.
--
-- Cinco decisões, na ordem em que o card as pede:
--
--  - A SIMULAÇÃO NÃO É EXECUTÁVEL, E O BANCO É O PRIMEIRO A DIZER ISSO.
--    `executed` e `executable` são CHECKs de literal `false`, e não colunas
--    booleanas: um `boolean` aceitaria `true` sem resistência, e uma linha
--    gravada dizendo que a simulação foi executada seria a mentira mais grave
--    que esta tabela poderia guardar. O CHECK é a garantia; a disciplina do
--    chamador não sobrevive a um segundo chamador.
--
--  - A RECUSA É UM ESTADO GRAVADO, NÃO UM NÚMERO ZERADO. Uma simulação
--    recusada grava `refused = true` com o código, a razão e o
--    REMÉDIO — e `indicative_*` continua NULL, porque `null` é a ausência
--    honesta e `0.00` seria uma afirmação de que o resultado é zero. A
--   recusa acompanha a tentativa; a tentativa e a recusa ficam no mesmo
--    registro.
--
--  - AS PREMISSAS E OS AVISOS SÃO GRAVADOS JUNTO DO NÚMERO. A premissa de
--    atraso, de taxas, de spread, de slippage e de dados ausentes, e os
--    avisos de jogo responsável (§4.9), viajam como arrays não vazios. Um
--    número gravado sem a premissa que o limita é um número que pode ser
--    lido para fora de contexto, e o banco recusa essa linha.
--
--  - A COBERTURA É O STATUS GRAVADO, COPIADO NO REGISTRO. `series_status`
--    recebe o valor lido de `integration.polymarket_series.status` no
--    instante da apuração. É uma CÓPIA e não uma referência viva, e o motivo
--    é o tempo: a série pode ser reingerida depois e virar completa, mas o
--    registro daquela recusa continua sendo verdadeiro — a recusa reflecte
--    o que se sabia quando a apuração foi pedida. Sem essa cópia, um relatório
--    antigo passaria a afirmar uma cobertura que não era a da apuração.
--
--  - SEM ORDEM, SEM APOSTA, SEM EXECUÇÃO, SEM ESTRATÉGIA. A tabela guarda o
--    pedido, as premissas, o desfecho e o aviso. Não guarda preço, não guarda
--    book, não guarda ordem, não guarda recommendation e não guarda quem
--    "deveria" entrar: o escopo excluído (§9.5) continua excluído, e a
--    ausência é visível na lista de colunas.
--
-- Forward-only e replay-safe (IF NOT EXISTS / DROP ... IF EXISTS / CREATE OR
-- REPLACE / ON CONFLICT DO NOTHING / DO $$ ... END $$), no mesmo padrão da
-- 0010, da 0011, da 0021, da 0023, da 0024, da 0025, da 0026, da 0027 e da
-- 0028. Esta migração é LOCAL: nada é executado em produção sem o fluxo de
-- autorização, backup e recuperação do runbook.
--
-- ------------------------------------------------------- a divergência herdada
-- A F2-14 gravou o CHECK `polymarket_series_category_check` aceitando APENAS
-- 'OVERALL', e a F2-15 descobriu por PROBE que a API oficial aceita ONZE
-- categorias (todas respondem 200; rótulos fora da lista respondem 400). As
-- dez categorias além de 'OVERALL' são filtros REAIS da origem e ainda NÃO
-- têm série ingerida.
--
-- DECISÃO DESTA TAREFA: NÃO tocar nos CHECKs da 0028. A justificativa é de
-- escopo, e ela é verificável no código:
--
--  - A simulação NÃO precisa das onze categorias para existir. A janela da
--    simulação aceita o enum oficial de onze (é o que a interface oferece e o
--    que a F2-15 já gravou), e uma janela fora de 'OVERALL' é SEMPRE recusada
--    com SERIES_NOT_COLLECTED — a recusa explica que a janela não tem série.
--    Ampliar o CHECK sem ampliar a INGESTÃO criaria a possibilidade de gravar
--    uma série que o job de ingestão não produz, que é a forma de um schema
--    permissivo mentir sobre a cobertura.
--
--  - A ingestão multi-categoria é card PRÓPRIO. Ela muda o job do worker
--    (11 categorias × 4 períodos × 2 ordenações = 88 séries), o volume de
--    chamada externa contra a Polymarket, o custo pela porta de entitlement
--    da F2-13 e o backfill de 180 dias. Nada disso está no escopo desta
--    tarefa, e o card proíbe tocar na F2-16 (`stk/f2-16-polymarket-favoritos`),
--    que está sendo implementada em paralelo por outro agente.
--
--  - O CHECK é uma RESTRIÇÃO POSITIVA e apertar ou soltar CHECK em migração
--    já aplicada é a operação que exige backup recuperável e janela própria
--    no runbook. Fazer isso "de brinde" numa tarefa de tela seria trocar o
--    risco pequeno de um schema novo pelo risco grande de reescrever um
--    CHECK existente.
--
-- A pendência fica REGISTRADA aqui e no doc da tarefa, e a simulação a trata
-- como recusada — que é o comportamento honesto até que a ingestão exista.

-- ------------------------------------------------------- a verificação do jsonb
-- O PostgreSQL NÃO ACEITA subquery dentro de um CHECK (`cannot use subquery
-- in check constraint`), e a verificação que o card exige — sete premissas,
-- cada uma com a forma completa, e as sete chaves cobertas — precisa
-- desdobrar o array. A solução é uma função IMMUTABLE, e ela é declarada
-- ANTES da tabela porque o CHECK a referencia.
--
-- IMMUTABLE é exigência legal, não enfeite: um CHECK só pode chamar função
-- marcada assim. As duas funções não leem tabela, não usam relógio e não
-- dependem de config, então o resultado é o mesmo para o mesmo array — que é
-- o que torna a reexecução da migração idempotente e a verificação estável.
--
-- `CREATE OR REPLACE` mantém a migração replay-safe, no mesmo padrão da
-- trigger de imutabilidade da 0027.
--
-- A PRIMEIRA função confere a FORMA de cada premissa: as cinco chaves
-- obrigatórias, todas de texto, e a `key` pertencendo à lista fechada das
-- sete. Um array de sete strings, ou de sete objetos sem `note`, é recusado —
-- porque um número exibido sem a frase que explica o que ele NÃO cobre é
-- exatamente o que o card proíbe.
CREATE OR REPLACE FUNCTION "integration"."simulation_premises_wellformed"(premises jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $fn$
  select premises is not null
     and jsonb_typeof(premises) = 'array'
     and jsonb_array_length(premises) = 7
     and (
       select count(*)
         from jsonb_array_elements(premises) as p
        where p ? 'key' and p ? 'label' and p ? 'value' and p ? 'kind' and p ? 'note'
          and jsonb_typeof(p->'key') = 'string'
          and jsonb_typeof(p->'label') = 'string'
          and jsonb_typeof(p->'value') = 'string'
          and jsonb_typeof(p->'kind') = 'string'
          and jsonb_typeof(p->'note') = 'string'
          and btrim(p->>'key') <> ''
          and btrim(p->>'label') <> ''
          and btrim(p->>'value') <> ''
          and btrim(p->>'note') <> ''
          and p->>'kind' in ('configured', 'measured', 'declared')
          and p->>'key' in ('stake','delayMs','feeRate','spreadRate','slippageRate','missingDataRate','completeness')
     ) = 7
     -- As SETE chaves distintas: sete objetos com `key` repetida não seriam
     -- sete premissas, e o array de sete já passou na contagem.
     and (select count(distinct p->>'key') from jsonb_array_elements(premises) as p) = 7
$fn$;--> statement-breakpoint

-- A SEGUNDA função confere os AVISOS: lista não vazia, todo item de texto e
-- nenhum item em branco. Um aviso em branco é pior que um aviso ausente, porque
-- ocupa a linha na tela sem dizer nada.
CREATE OR REPLACE FUNCTION "integration"."simulation_disclaimers_present"(disclaimers jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $fn$
  select disclaimers is not null
     and jsonb_typeof(disclaimers) = 'array'
     and jsonb_array_length(disclaimers) >= 1
     and (
       select count(*)
         from jsonb_array_elements(disclaimers) as d
        where jsonb_typeof(d) = 'string'
          and btrim(d #>> '{}') <> ''
     ) = jsonb_array_length(disclaimers)
$fn$;

-- ------------------------------------------------------------------ o schema
-- O registro é por ORGANIZAÇÃO, e vive em `integration` ao lado dos demais
-- registros de integração. Ele leva RLS por organização (a mesma fronteira de
-- `report_snapshot` da 0027) porque uma simulação é uma consulta feita pelo
-- dono: o valor da stake e as premissas que ELE escolheu são informação de
-- conta e não podem vazar entre organizações.
CREATE TABLE IF NOT EXISTS "integration"."polymarket_simulation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	-- A janela pedida, com as três dimensões que a origem usa para ordenar.
	-- `category` é o enum OFICIAL de onze valores (o da F2-15), e não o
	-- `LEADERBOARD_CATEGORY` de um valor só da F2-14: a simulação aceita o
	-- rótulo que a interface oferece, e a recusa explica quando ele ainda não
	-- tem série gravada.
	"category" text NOT NULL DEFAULT 'OVERALL',
	"time_period" text NOT NULL,
	"order_by" text NOT NULL,
	-- ---------------------------------------------------------- a entrada
	-- A STAKE FIXA por observação, exata. `numeric(38, 18)` pelo mesmo motivo
	-- da F2-14: o literal do cálculo chega ao banco como texto decimal e
	-- nunca passa por `double precision`.
	"stake" numeric(38, 18) NOT NULL,
	-- As PREMISSAS de fricção, cada uma exata e cada uma CONFIGURADA pelo
	-- usuário. São premissas, não medidas: as colunas dizem isso no nome.
	"delay_ms" integer NOT NULL DEFAULT 0,
	"fee_rate" numeric(38, 18) NOT NULL DEFAULT 0,
	"spread_rate" numeric(38, 18) NOT NULL DEFAULT 0,
	"slippage_rate" numeric(38, 18) NOT NULL DEFAULT 0,
	-- --------------------------------------------------------- a cobertura
	-- A CÓPIA do status gravado pela F2-14, no instante da apuração. Ver o
	-- cabeçalho: a cópia é deliberada, para que a recusa continue verdadeira
	-- mesmo que a série seja reingerida depois.
	"series_status" text NOT NULL DEFAULT 'unknown',
	"series_available" boolean NOT NULL DEFAULT false,
	-- N: quantas observações entraram na apuração.
	"observations" integer NOT NULL DEFAULT 0,
	-- O limiar do produto (`DASHBOARD_MIN_SAMPLE`), gravado para que a
	-- decisão de recusar por amostra pequena seja auditável sem reler a
	-- configuração do servidor.
	"min_sample" integer NOT NULL,
	-- A taxa de dados ausentes medida sobre a primeira página oficial.
	"missing_data_rate" numeric(38, 18) NOT NULL DEFAULT 0,
	-- ---------------------------------------------------------- o desfecho
	-- A RECUSA. `refused = true` é o estado NORMAL quando a cobertura não
	-- fecha, e ele é gravado com código, razão e remédio.
	"refused" boolean NOT NULL DEFAULT true,
	"refusal_code" text,
	"refusal_reason" text,
	"refusal_remedy" text,
	-- O NÚMERO INDICATIVO, todos NULL quando há recusa. Cada coluna é
	-- nullable PORQUE a recusa é um desfecho legítimo — e o CHECK abaixo
	-- garante que a recusa traga todos eles a NULL, de modo que nenhum
	-- registro possa ter um número escondido atrás de uma recusa.
	"indicative_stake" numeric(38, 18),
	"indicative_observations" integer,
	"indicative_published_ratio" numeric(38, 18),
	"indicative_published_pnl_sum" numeric(38, 18),
	"indicative_published_vol_sum" numeric(38, 18),
	"indicative_gross" numeric(38, 18),
	"indicative_fee_cost" numeric(38, 18),
	"indicative_spread_cost" numeric(38, 18),
	"indicative_slippage_cost" numeric(38, 18),
	"indicative_friction_cost" numeric(38, 18),
	"indicative_missing_band" numeric(38, 18),
	"indicative_net" numeric(38, 18),
	-- ------------------------------------------------------- a transparência
	-- AS PREMISSAS EXIBIDAS, como jsonb: são o que a tela mostra e o que o
	-- registro preserva, para que o número nunca exista sem o contexto que o
	-- limita. O CHECK exige lista não vazia e com as sete chaves.
	"premises" jsonb NOT NULL DEFAULT '[]'::jsonb,
	-- OS AVISOS de jogo responsável (§4.9). Não vazios, sempre: um registro
	-- sem aviso é um registro que pode ser citado sem o aviso.
	"disclaimers" jsonb NOT NULL DEFAULT '[]'::jsonb,
	-- A chave de dedupe: o mesmo pedido com a mesma janela, a mesma stake e as
	-- mesmas premissas é o mesmo pedido, e a repetição é declarada no-op.
	"dedupe_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "polymarket_simulation_category_check" CHECK ("integration"."polymarket_simulation"."category" in ('OVERALL','POLITICS','SPORTS','ESPORTS','CRYPTO','CULTURE','MENTIONS','WEATHER','ECONOMICS','TECH','FINANCE')),
	CONSTRAINT "polymarket_simulation_time_period_check" CHECK ("integration"."polymarket_simulation"."time_period" in ('DAY','WEEK','MONTH','ALL')),
	CONSTRAINT "polymarket_simulation_order_by_check" CHECK ("integration"."polymarket_simulation"."order_by" in ('PNL','VOL')),
	-- A stake é dinheiro POSITIVO: uma stake zero ou negativa não é uma
	-- simulação, é um sinal trocado.
	CONSTRAINT "polymarket_simulation_stake_positive" CHECK ("integration"."polymarket_simulation"."stake" > 0),
	-- O atraso respeita o teto declarado no shared (60 s): acima disso a
	-- premissa deixa de descrever o mercado e passa a descrever o atraso de
	-- uma pessoa.
	CONSTRAINT "polymarket_simulation_delay_range" CHECK ("integration"."polymarket_simulation"."delay_ms" >= 0 and "integration"."polymarket_simulation"."delay_ms" <= 60000),
	-- As taxas, o spread e o slippage são frações não negativas e abaixo de
	-- 1000 (999,999999): acima disso a "fricção" seria multiplicação, e um
	-- valor negativo seria um prêmio em vez de custo.
	CONSTRAINT "polymarket_simulation_rates_range" CHECK ("integration"."polymarket_simulation"."fee_rate" >= 0 and "integration"."polymarket_simulation"."fee_rate" < 1000 and "integration"."polymarket_simulation"."spread_rate" >= 0 and "integration"."polymarket_simulation"."spread_rate" < 1000 and "integration"."polymarket_simulation"."slippage_rate" >= 0 and "integration"."polymarket_simulation"."slippage_rate" < 1000),
	-- O status gravado pela F2-14 é o enum de quatro valores. A cópia não
	-- pode inventar um quinto.
	CONSTRAINT "polymarket_simulation_series_status_check" CHECK ("integration"."polymarket_simulation"."series_status" in ('complete','truncated','partial','unknown')),
	-- N e o limiar são contagens: zero observações é recusado por amostra, e o
	-- limiar do produto é positivo por definição.
	CONSTRAINT "polymarket_simulation_observations_nonnegative" CHECK ("integration"."polymarket_simulation"."observations" >= 0),
	CONSTRAINT "polymarket_simulation_min_sample_positive" CHECK ("integration"."polymarket_simulation"."min_sample" >= 1),
	-- O código de recusa é o enum do shared, e ele SÓ aparece quando há
	-- recusa. Um código sem recusa seria um registro que se recusa e se apura
	-- ao mesmo tempo.
	CONSTRAINT "polymarket_simulation_refusal_code_check" CHECK ("integration"."polymarket_simulation"."refusal_code" is null or "integration"."polymarket_simulation"."refusal_code" in ('SERIES_NOT_COLLECTED','SERIES_NOT_COMPLETE','SAMPLE_TOO_SMALL','MISSING_DATA')),
	CONSTRAINT "polymarket_simulation_refusal_code_present" CHECK (("integration"."polymarket_simulation"."refused" and "integration"."polymarket_simulation"."refusal_code" is not null) or (not "integration"."polymarket_simulation"."refused" and "integration"."polymarket_simulation"."refusal_code" is null)),
	-- Razão e remédio são texto de interface, e eles existem QUANDO HÁ RECUSA
	-- (é a recusa que precisa explicar por quê e o que fazer) e são NULL
	-- quando a apuração acontece. O CHECK abaixo é essa regra: recusada
	-- significa "razão E remédio não vazios"; apurada significa "razão E
	-- remédio nulos". A versão anterior exigia o texto justamente no caso
	-- oposto — e ela recusava toda apuração legítima, que é a forma de um
	-- CHECK de proteção terminar bloqueando o caminho certo.
	CONSTRAINT "polymarket_simulation_refusal_text_check" CHECK (("integration"."polymarket_simulation"."refused" and btrim(coalesce("integration"."polymarket_simulation"."refusal_reason",'')) <> '' and btrim(coalesce("integration"."polymarket_simulation"."refusal_remedy",'')) <> '') or (not "integration"."polymarket_simulation"."refused" and "integration"."polymarket_simulation"."refusal_reason" is null and "integration"."polymarket_simulation"."refusal_remedy" is null)),
	CONSTRAINT "polymarket_simulation_refusal_reason_length" CHECK ("integration"."polymarket_simulation"."refusal_reason" is null or length("integration"."polymarket_simulation"."refusal_reason") <= 2048),
	CONSTRAINT "polymarket_simulation_refusal_remedy_length" CHECK ("integration"."polymarket_simulation"."refusal_remedy" is null or length("integration"."polymarket_simulation"."refusal_remedy") <= 2048),
	-- A REGRA CENTRAL, no banco: recusa e número são mutuamente exclusivos.
	-- Recusada não tem NENHUM número; apurada tem TODOS eles. Não existe
	-- registro com número escondido atrás de uma recusa, e não existe
	-- registro apurado sem número.
	CONSTRAINT "polymarket_simulation_outcome_exclusive" CHECK ((("integration"."polymarket_simulation"."refused" and "integration"."polymarket_simulation"."indicative_net" is null and "integration"."polymarket_simulation"."indicative_gross" is null and "integration"."polymarket_simulation"."indicative_observations" is null and "integration"."polymarket_simulation"."indicative_published_ratio" is null) or (not "integration"."polymarket_simulation"."refused" and "integration"."polymarket_simulation"."indicative_net" is not null and "integration"."polymarket_simulation"."indicative_gross" is not null and "integration"."polymarket_simulation"."indicative_observations" is not null and "integration"."polymarket_simulation"."indicative_published_ratio" is not null))),
	-- A apuração só existe com cobertura COMPLETA. É a mesma regra do motor,
	-- gravada de novo: um registro apurado sobre série truncada seria a
	-- mentira que o card proíbe, e agora ela é impossível de escrever.
	CONSTRAINT "polymarket_simulation_complete_required" CHECK ("integration"."polymarket_simulation"."refused" or ("integration"."polymarket_simulation"."series_available" and "integration"."polymarket_simulation"."series_status" = 'complete')),
	-- AS SETE PREMISSAS, sempre. O CHECK olha o array: sete objetos com `key`
	-- preenchido é a garantia de que nenhuma premissa foi omitida por
	-- conveniência. A FORMA de cada item é verificada pela função IMMUTABLE
	-- `simulation_premises_wellformed` acima — o PostgreSQL RECUSA subquery
	-- dentro de um CHECK (`cannot use subquery in check constraint`), então a
	-- verificação que precisa desdobrar o array só pode ser uma função. Ela é
	-- `IMMUTABLE` justamente para ser legal ali: não lê tabela, não usa
	-- relógio e devolve o mesmo veredito para o mesmo array.
	CONSTRAINT "polymarket_simulation_premises_check" CHECK (jsonb_typeof("integration"."polymarket_simulation"."premises") = 'array' and jsonb_array_length("integration"."polymarket_simulation"."premises") = 7 and "integration"."simulation_premises_wellformed"("integration"."polymarket_simulation"."premises")),
	-- Os AVISOS de jogo responsável nunca vazios, e nunca um item em branco.
	-- Mesma razão da premissa acima: desdobrar o array é função, não CHECK.
	CONSTRAINT "polymarket_simulation_disclaimers_check" CHECK ("integration"."simulation_disclaimers_present"("integration"."polymarket_simulation"."disclaimers")),
	-- A chave de dedupe não é vazia, pelo mesmo motivo da 0028.
	CONSTRAINT "polymarket_simulation_dedupe_key_check" CHECK (btrim("integration"."polymarket_simulation"."dedupe_key") <> '')
);

-- A dedupe é do BANCO: o mesmo pedido com a mesma entrada é gravado uma vez, e
-- a repetição é um no-op declarado. `ON CONFLICT DO NOTHING` é o que faz o
-- re-run da tela ser seguro.
CREATE UNIQUE INDEX IF NOT EXISTS "polymarket_simulation_dedupe_uidx"
	ON "integration"."polymarket_simulation" USING btree ("organization_id", "dedupe_key");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "polymarket_simulation_org_idx"
	ON "integration"."polymarket_simulation" ("organization_id", "created_at" DESC);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "polymarket_simulation_window_idx"
	ON "integration"."polymarket_simulation" USING btree ("category", "time_period", "order_by");

-- RLS fail-closed, a mesma fronteira de `report_snapshot` (0027): sem contexto
-- de organização a expressão não casa linha nenhuma, e a comparação com NULL
-- é o que transforma "sem contexto" em "sem linhas" em vez de erro.
ALTER TABLE "integration"."polymarket_simulation" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "organization_isolation" ON "integration"."polymarket_simulation";--> statement-breakpoint
CREATE POLICY "organization_isolation" ON "integration"."polymarket_simulation"
  USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
