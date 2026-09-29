-- STK-F2-14 — ingestão Polymarket: traders, séries e agregados do leaderboard.
--
-- Cinco decisões, na ordem em que o card as pede:
--
--  - O VALOR É EXATO OU NÃO É VALOR. `vol` e `pnl` chegam da origem como
--    NÚMEROS JSON, isto é, já descompactados por IEEE-754 antes de qualquer
--    código nosso: a resposta real traz `2666493.7190210004`, que não
--    sobrevive a um `number` do JavaScript. Por isso as colunas são
--    `numeric(38, 18)` — texto decimal exato no Postgres, nunca `double
--    precision` — e a aplicação entrega o LITERAL de texto do JSON, não um
--    float já degradado. `float8` aqui seria um erro silencioso de
--    precisão, e o CHECK abaixo recusa qualquer valor que não caiba.
--
--  - A CHAVE DE ORIGEM É OBBRIGATORIAMENTE NÃO NULA, E A DEDUP É DO BANCO.
--    `source_key` é `NOT NULL` e é a chave única da observação. Ela NUNCA é
--    o `txHash`: o hash de transação é anulável e, isolado, colide entre
--    traders diferentes que compartilham uma transação. `tx_hash` existe
--    aqui como COLUNA SEPARADA e anulável, para guarda — nunca como chave.
--    Rodar o backfill duas vezes não produz linhas novas: a segunda inserção
--    colide com a chave única e é um no-op declarado.
--
--  - A COMPLETUDE É UM DADO, NÃO UMA AUSÊNCIA. A origem nunca declara que
--    acabou: `offset=5000` responde 200 com a página cheia. Por isso
--    `polymarket_series.status` é um CHECK de enum ('complete','truncated',
--    'partial','unknown') gravado pela aplicação, e cada `polymarket_page`
--    guarda o offset consumido. Um rango TRUNCADO é identificado no próprio
--    banco: nenhum leitor pode receber uma série truncada como se fosse
--    completa, porque a completude é consultada junto com a contagem.
--
--  - A RETENÇÃO É DIFERENTE POR CAMADA, E O BANCO IMPÕE A DIFERENÇA. Trades
--    brutos (o detalhe por observação) retêm 180 dias; agregados (a série
--    resumida) retêm por prazo maior, porque é a soma que responde
--    pergunta de prazo longo. As duas janelas vivem em
--    `integration.polymarket_retention` e a aplicação as lê de lá.
--
--  - SEM ÍNDICE ON-CHAIN, SEM ORDEM, SEM CARTEIRA DE TERCEIROS, SEM KALSHI.
--    A única entidade é o trader do LEADERBOARD. Nenhuma tabela daqui
--    guarda ordem, aposta, trade individual ou wallet de usuário do produto:
--    o escopo excluído (§9.1) continua excluído, e a ausência é visível na
--    lista de tabelas.
--
-- Forward-only e replay-safe (IF NOT EXISTS / DROP ... IF EXISTS / CREATE OR
-- REPLACE / ON CONFLICT DO NOTHING / DO $$ ... END $$), no mesmo padrão da
-- 0010, da 0011, da 0021, da 0023, da 0024, da 0025, da 0026 e da 0027. Esta
-- migração é LOCAL: nada é executado em produção sem o fluxo de autorização,
-- backup e recuperação do runbook.

-- ------------------------------------------------------------------ o schema
-- O dado é público, de integração externa e SEM PII (a carteira é um
-- identificador on-chain público), então vive em `integration` e NÃO leva
-- RLS: não é dado privado de organização. Ele também NÃO é global por
-- acidente — toda linha carrega a janela da origem, e a chave de dedup
-- inclui a janela, então o mesmo trader observado em janelas diferentes são
-- duas observações diferentes, como devem ser.
CREATE SCHEMA IF NOT EXISTS "integration";
--> statement-breakpoint

-- ------------------------------------------------------------- o trader
-- Uma linha por TRADER observado, dentro de uma janela. A chave é a
-- observação completa (ver `leaderboardSourceKey` no shared), o que torna a
-- deduplicação determinística: mesma linha da origem, mesma chave, sempre.
CREATE TABLE IF NOT EXISTS "integration"."polymarket_trader" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	-- Identidade declarada pela origem (`proxyWallet`), em minúsculas: a
	-- chave de dedup é canônica, e `0xAB` e `0xab` são o mesmo trader.
	"proxy_wallet" text NOT NULL,
	"user_name" text NOT NULL DEFAULT '',
	"x_username" text NOT NULL DEFAULT '',
	"profile_image" text NOT NULL DEFAULT '',
	"verified_badge" boolean NOT NULL DEFAULT false,
	-- A chave de origem: NOT NULL por CHECK e por ser chave única. Sem ela
	-- não existe dedup; com ela, o replay é um no-op.
	"source_key" text NOT NULL,
	-- Hash de transação, GUARDA e não chave. Anulável de propósito: quando
	-- existe, é evidência; quando não, a linha segue válida porque a
	-- identidade vem do par (janela + observação).
	"tx_hash" text,
	-- Valor EXATO do volume como texto decimal. `numeric(38, 18)` guarda o
	-- literal; um double precision aqui perderia dígitos que a origem
	-- mandou.
	"vol" numeric(38, 18) NOT NULL,
	-- Valor EXATO do P&L como texto decimal.
	"pnl" numeric(38, 18) NOT NULL,
	-- Posição declarada pela origem, como TEXTO: um rank é uma posição
	-- declarada, não uma medida numérica medida por nós.
	"rank" text NOT NULL,
	-- A janela que produziu esta observação: as três dimensões que a
	-- origem usa para ordenar. Faz parte da chave de dedup.
	"category" text NOT NULL DEFAULT 'OVERALL',
	"time_period" text NOT NULL,
	"order_by" text NOT NULL,
	-- Quando esta observação foi gravada.
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "polymarket_trader_wallet_check" CHECK ("integration"."polymarket_trader"."proxy_wallet" ~ '^0x[0-9a-f]{40}$'),
	-- A chave de origem NÃO PODE ser vazia nemBranched. Este é o CHECK que
	-- transforma "chave de fonte não nula" em invariante do banco: um
	-- INSERT sem chave é recusado pelo Postgres, não detectado depois.
	CONSTRAINT "polymarket_trader_source_key_check" CHECK (length(btrim("integration"."polymarket_trader"."source_key")) > 0),
	CONSTRAINT "polymarket_trader_category_check" CHECK ("integration"."polymarket_trader"."category" in ('OVERALL')),
	CONSTRAINT "polymarket_trader_time_period_check" CHECK ("integration"."polymarket_trader"."time_period" in ('DAY','WEEK','MONTH','ALL')),
	CONSTRAINT "polymarket_trader_order_by_check" CHECK ("integration"."polymarket_trader"."order_by" in ('PNL','VOL')),
	CONSTRAINT "polymarket_trader_rank_check" CHECK ("integration"."polymarket_trader"."rank" ~ '^\d{1,9}$'),
	-- `tx_hash`, quando presente, é um hash: 0x + 64 hex. A forma é imposta
	-- para que ninguém guarde um id de ordem ou uma wallet no campo que se
	-- lê como hash de transação.
	CONSTRAINT "polymarket_trader_tx_hash_check" CHECK ("integration"."polymarket_trader"."tx_hash" is null or "integration"."polymarket_trader"."tx_hash" ~ '^0x[0-9a-fA-F]{64}$')
);
--> statement-breakpoint

-- A dedup determinística: a chave única É a deduplicação. Reexecutar o
-- backfill devolve conflito, e o chamador trata o conflito como "já estava".
CREATE UNIQUE INDEX IF NOT EXISTS "polymarket_trader_source_key_uidx"
	ON "integration"."polymarket_trader" USING btree ("source_key");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "polymarket_trader_wallet_idx"
	ON "integration"."polymarket_trader" USING btree ("proxy_wallet", "time_period");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "polymarket_trader_observed_at_idx"
	ON "integration"."polymarket_trader" USING btree ("observed_at");
--> statement-breakpoint

-- --------------------------------------------------------------- a série
-- Uma linha por JANELA ingerida: início, fim, quantidade, cursor e
-- completude. Este é o registro que a interface lê para dizer "cobertura
-- completa" ou "série TRUNCADA" — e ela NUNCA infere isso da contagem de
-- linhas.
CREATE TABLE IF NOT EXISTS "integration"."polymarket_series" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	-- A janela, que é a identidade da série. Uma série por (category,
	-- time_period, order_by): são as três dimensões que a origem ordena.
	"category" text NOT NULL DEFAULT 'OVERALL',
	"time_period" text NOT NULL,
	"order_by" text NOT NULL,
	-- Início e fim da COBERTURA declarada, em instante. `window_from` é o
	-- instante a partir do qual esta série afirma cobrir; `window_to` é o
	-- instante mais recente coberto. Os dois são gravados, nunca deduzidos.
	"window_from" timestamp with time zone NOT NULL,
	"window_to" timestamp with time zone NOT NULL,
	-- A data mais ANTIGA que este backfill tentou cobrir: a âncora dos
	-- 180 dias. É ela que faz a série datável no card.
	"backfill_from" date NOT NULL,
	-- Cursor = o ÚLTIMO offset consumido com sucesso. `null` significa que
	-- nenhuma página foi consumida; um número é a última posição lida.
	"cursor" integer,
	-- Quantos registros foram ACEITOS (após contrato) nesta série.
	"quantity" integer NOT NULL DEFAULT 0,
	-- Quantas páginas foram consumidas e quantas FALHARAM. Uma falha por
	-- página é o que torna a série `partial`, e é por isso que o job não
	-- pode se reportar como sucesso com `failed_pages` > 0.
	"pages" integer NOT NULL DEFAULT 0,
	"failed_pages" integer NOT NULL DEFAULT 0,
	-- A COMPLETUDE, gravada e CHECK-ada. 'truncated' é o estado real e
	-- normal deste backfill: a origem não declara fim, então uma série
	-- truncada é o resultado honesto, nunca uma série apresentada como
	-- completa.
	"status" text NOT NULL DEFAULT 'unknown',
	-- Erros sanitizados desta série, sem corpo de resposta, sem URL e sem
	-- identificador de trader.
	"errors" jsonb NOT NULL DEFAULT '[]'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "polymarket_series_category_check" CHECK ("integration"."polymarket_series"."category" in ('OVERALL')),
	CONSTRAINT "polymarket_series_time_period_check" CHECK ("integration"."polymarket_series"."time_period" in ('DAY','WEEK','MONTH','ALL')),
	CONSTRAINT "polymarket_series_order_by_check" CHECK ("integration"."polymarket_series"."order_by" in ('PNL','VOL')),
	CONSTRAINT "polymarket_series_window_ordered" CHECK ("integration"."polymarket_series"."window_from" <= "integration"."polymarket_series"."window_to"),
	CONSTRAINT "polymarket_series_quantity_nonnegative" CHECK ("integration"."polymarket_series"."quantity" >= 0),
	CONSTRAINT "polymarket_series_pages_nonnegative" CHECK ("integration"."polymarket_series"."pages" >= 0),
	CONSTRAINT "polymarket_series_failed_pages_nonnegative" CHECK ("integration"."polymarket_series"."failed_pages" >= 0),
	-- Um cursor é um offset: 0 é a primeira página e é VÁLIDO, então o
	-- CHECK é sobre a faixa, não sobre a nulidade.
	CONSTRAINT "polymarket_series_cursor_range" CHECK ("integration"."polymarket_series"."cursor" is null or "integration"."polymarket_series"."cursor" >= 0),
	-- A completude é um ENUM do banco. Uma série truncada não pode ser lida
	-- como completa por descuido: o valor errado é recusado na escrita.
	CONSTRAINT "polymarket_series_status_check" CHECK ("integration"."polymarket_series"."status" in ('complete','truncated','partial','unknown'))
);
--> statement-breakpoint

-- A identidade da série: uma por janela. `ON CONFLICT` nesta chave é o que
-- torna o re-run do backfill uma ATUALIZAÇÃO da mesma série, nunca uma
-- segunda série paralela.
CREATE UNIQUE INDEX IF NOT EXISTS "polymarket_series_window_uidx"
	ON "integration"."polymarket_series" USING btree ("category", "time_period", "order_by");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "polymarket_series_status_idx"
	ON "integration"."polymarket_series" USING btree ("status");
--> statement-breakpoint

-- ------------------------------------------------------------- as páginas
-- Uma linha por página CONSUMIDA: o rastro de onde a ingestão parou e o que
-- falhou. Sem isto, "quantos registros tenho" e "a partir de onde posso
-- retomar" seriam a mesma pergunta sem resposta.
CREATE TABLE IF NOT EXISTS "integration"."polymarket_page" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"series_id" uuid NOT NULL,
	"offset" integer NOT NULL,
	"received" integer NOT NULL DEFAULT 0,
	"accepted" integer NOT NULL DEFAULT 0,
	-- A página veio inteira? `false` = a origem a cortou.
	"complete" boolean NOT NULL DEFAULT true,
	-- Erro sanitizado desta página, se houve.
	"error_code" text,
	-- `Retry-After` observado, em segundos, quando a origem o devolveu.
	"retry_after_seconds" integer,
	"consumed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "polymarket_page_series_fk" FOREIGN KEY ("series_id") REFERENCES "integration"."polymarket_series" ("id") ON DELETE CASCADE,
	CONSTRAINT "polymarket_page_offset_nonnegative" CHECK ("integration"."polymarket_page"."offset" >= 0),
	CONSTRAINT "polymarket_page_received_nonnegative" CHECK ("integration"."polymarket_page"."received" >= 0),
	CONSTRAINT "polymarket_page_accepted_nonnegative" CHECK ("integration"."polymarket_page"."accepted" >= 0),
	-- Aceito não pode passar do recebido: a rejeição por contrato é o resto.
	CONSTRAINT "polymarket_page_accepted_within_received" CHECK ("integration"."polymarket_page"."accepted" <= "integration"."polymarket_page"."received"),
	CONSTRAINT "polymarket_page_retry_after_nonnegative" CHECK ("integration"."polymarket_page"."retry_after_seconds" is null or "integration"."polymarket_page"."retry_after_seconds" >= 0)
);
--> statement-breakpoint

-- Uma página por offset dentro da série: o re-run não duplica o rastro, e a
-- conflict resolve o "já consumida".
CREATE UNIQUE INDEX IF NOT EXISTS "polymarket_page_series_offset_uidx"
	ON "integration"."polymarket_page" USING btree ("series_id", "offset");
--> statement-breakpoint

-- ---------------------------------------------------------------- os agregados
-- A SOMA por prazo, que responde pergunta de prazo longo depois que o
-- detalhe expira. O agregador roda sobre `numeric(38, 18)` — soma exata — e
-- o resultado é gravado com a MESMA escala, sem passar por float.
CREATE TABLE IF NOT EXISTS "integration"."polymarket_aggregate" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	-- A granularidade do agregado: 'day' | 'week' | 'month'. É a resposta
	-- que sobrevive depois que o bruto sai da retenção.
	"bucket" text NOT NULL,
	-- A data civil do bucket (America/Sao_Paulo do produto), como `date`.
	"bucket_on" date NOT NULL,
	-- Dimensões do agregado. `proxy_wallet` anulável porque o agregado do
	-- período (sem trader) também é uma resposta legítima.
	"proxy_wallet" text,
	"time_period" text NOT NULL,
	"order_by" text NOT NULL,
	-- Somas EXATAS, no mesmo tipo do bruto: `numeric(38, 18)`.
	"vol_total" numeric(38, 18) NOT NULL DEFAULT 0,
	"pnl_total" numeric(38, 18) NOT NULL DEFAULT 0,
	-- Contagem de traders que entraram no agregado.
	"traders" integer NOT NULL DEFAULT 0,
	-- A versão da agregação: reprocessar o mesmo dia grava uma versão nova
	-- em vez de sobrescrever a anterior, para que o número tenha histórico.
	"version" integer NOT NULL DEFAULT 1,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "polymarket_aggregate_bucket_check" CHECK ("integration"."polymarket_aggregate"."bucket" in ('day','week','month')),
	CONSTRAINT "polymarket_aggregate_wallet_check" CHECK ("integration"."polymarket_aggregate"."proxy_wallet" is null or "integration"."polymarket_aggregate"."proxy_wallet" ~ '^0x[0-9a-f]{40}$'),
	CONSTRAINT "polymarket_aggregate_time_period_check" CHECK ("integration"."polymarket_aggregate"."time_period" in ('DAY','WEEK','MONTH','ALL')),
	CONSTRAINT "polymarket_aggregate_order_by_check" CHECK ("integration"."polymarket_aggregate"."order_by" in ('PNL','VOL')),
	CONSTRAINT "polymarket_aggregate_traders_nonnegative" CHECK ("integration"."polymarket_aggregate"."traders" >= 0),
	CONSTRAINT "polymarket_aggregate_version_positive" CHECK ("integration"."polymarket_aggregate"."version" >= 1)
);
--> statement-breakpoint

-- A identidade do agregado: bucket + data + trader (anulável) + janela. O
-- índice único precisa de `COALESCE` porque um índice único normal trata
-- `null` como DISTINTO de cada linha, e o agregado do período (sem trader)
-- criaria uma linha nova a cada reprocessamento em vez de colidir com a
-- anterior. Aspas duplas são identificadores, não expressões: o `coalesce`
-- fica SEM aspas e a coluna COM aspas.
CREATE UNIQUE INDEX IF NOT EXISTS "polymarket_aggregate_identity_uidx"
	ON "integration"."polymarket_aggregate"
	USING btree ("bucket", "bucket_on", "time_period", "order_by", (coalesce("proxy_wallet", '')));
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "polymarket_aggregate_bucket_idx"
	ON "integration"."polymarket_aggregate" USING btree ("bucket", "bucket_on");
--> statement-breakpoint

-- ----------------------------------------------------------- a retenção
-- As DUAS janelas, em uma tabela só, lidas pela aplicação. A distinção é o
-- ponto do card: o bruto some antes do agregado, e por isso o agregado é o
-- que responde o prazo longo.
CREATE TABLE IF NOT EXISTS "integration"."polymarket_retention" (
	"layer" text PRIMARY KEY NOT NULL,
	-- Prazo, em dias, que CADA camada guarda. O bruto é 180 (o card); o
	-- agregado é maior, porque é a soma de prazo longo.
	"retain_days" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "polymarket_retention_layer_check" CHECK ("integration"."polymarket_retention"."layer" in ('trade','aggregate')),
	CONSTRAINT "polymarket_retention_days_positive" CHECK ("integration"."polymarket_retention"."retain_days" > 0)
);
--> statement-breakpoint

-- O bruto: 180 dias, exatamente o prazo do card.
INSERT INTO "integration"."polymarket_retention" ("layer", "retain_days")
VALUES ('trade', 180)
ON CONFLICT ("layer") DO NOTHING;
--> statement-breakpoint

-- O agregado: 730 dias (2 anos). Maior que o bruto, como o card exige, e
-- grande o bastante para responder "como foi o ano" depois que o detalhe
-- já saiu.
INSERT INTO "integration"."polymarket_retention" ("layer", "retain_days")
VALUES ('aggregate', 730)
ON CONFLICT ("layer") DO NOTHING;
--> statement-breakpoint
