-- STK-F2-16 — favoritos, configuração de alertas de atividade e versões do
-- Composite Score silencioso.
--
-- Cinco decisões, na ordem em que o card as pede:
--
--  - DEZ FAVORITOS É LIMITE DO BANCO, E O EXCEDENTE É ERRO DO BANCO. A
--    aplicação decide com a função `favoritesAdmit`, mas o que fecha a corrida
--    entre dois pedidos simultâneos é o TRIGGER `polymarket_favorite_limit`:
--    ele conta as linhas do próprio usuário dentro da mesma transação e levanta
--    `FAVORITES_LIMIT_REACHED` (23514) na décima primeira. O limite é do banco
--    pelo mesmo motivo pelo qual o relatório congelado é imutável: disciplina
--    do chamador não sobrevive a um segundo chamador. Não existe paginação nem
--    truncamento — o card pede teto, e teto que corta a lista seria outro
--    produto.
--
--  - FAVORITAR NÃO É ATIVAR ALERTA, E O BANCO SEPARA AS DUAS COISAS. A
--    configuração vive em `polymarket_alert_config`, que NÃO tem chave
--    estrangeira para o favorito e NÃO é criada por nenhum INSERT de favorito.
--    Um usuário com dez favoritos e nenhum alerta é um estado que a migração
--    permite e que a aplicação deve saber descrever.
--
--  - A ATIVIDADE É LÍQUIDA POR JANELA DE 5 MIN, E A LINHA DE BASE É
--    GRAVADA. `polymarket_activity_window` guarda uma leitura por (usuário,
--    trader, janela): o volume observado e o instante da observação. O alerta
--    exige DUAS leituras — a primeira estabelece a linha de base e não gera
--    nada, porque atribuir a ela o volume acumulado desde sempre seria a maior
--    atividade falsa do sistema. O job grava a janela pelo `INSERT ... ON
--    CONFLICT` e o delta é calculado da linha anterior.
--
--  - O LIMIAR E O LIMITE DIÁRIO SÃO DO USUÁRIO E O PADRÃO É O DO CARD. A
--    coluna nasce com o default `1000` (US$ por janela de 5 min, o número do
--    card) e a ativação nasce DESLIGADA: favoritar um trader não pode virar o
--    interruptor do alerta, e um usuário que nunca pediu alerta não começa a
--    recebê-lo. O `window_minutes` é `NOT NULL DEFAULT 5` com CHECK de
--    igualdade — a janela é a definição do card, não uma preferência.
--
--  - O COMPOSITE SCORE É SILENCIOSO, VERSIONADO E PARALELO. A tabela existe,
--    a versão é monótona por janela e o score é gravado com a completude que a
--    F2-14 gravou — mas NENHUMA rota, NENHUM componente e NENHUMA tela lê esta
--    tabela. Ela é paralela por construção: o único caminho de leitura é o job
--    silencioso, e o teste §15 varre o código de produto procurando o termo.
--    Uma coluna `score` que alguém pudesse plugar no ranking depois seria
--    exatamente a dívida que o card proíbe criar agora.
--
-- As três tabelas são PRIVADAS: RLS habilitada, política por organização e
-- predicado explícito em toda consulta. O dado de Polymarket é público e sem
-- PII, mas o favorito, o limiar e a cota diária são configuração DO USUÁRIO — e
-- configuração de usuário não é dado público de integração, mesmo que aponte
-- para ele.
--
-- Forward-only e replay-safe (IF NOT EXISTS / DROP TRIGGER IF EXISTS / CREATE OR
-- REPLACE / ON CONFLICT DO NOTHING), no mesmo padrão da 0021, da 0023, da
-- 0024, da 0027 e da 0028. Esta migração é LOCAL: nada é executado em produção
-- sem o fluxo de autorização, backup e recuperação do runbook.

-- -------------------------------------------------------------------- fila
-- O alerta de atividade Polymarket (STK-F2-16) entra na MESMA fila durável da
-- F2-10 — uma fila por produto seria duas fontes de verdade sobre o que está
-- pendente de entrega. O CHECK de `topic` é RECRIADO com o valor novo, e o
-- replay converge: `DROP CONSTRAINT IF EXISTS` + `ADD CONSTRAINT` é o mesmo
-- padrão de `CREATE OR REPLACE` usado nas demais migrações.
--
-- `polymarket_activity` NÃO entra em `notification.preference.topics`: a
-- ativação desse alerta é a coluna `enabled` de `polymarket_alert_config`, e
-- dois interruptores para a mesma coisa produziriam divergência. A entrada no
-- `topics` da preferência continuaria sendo o controle do canal genérico.
ALTER TABLE "notification"."outbox" DROP CONSTRAINT IF EXISTS "notification_outbox_topic_check";--> statement-breakpoint
ALTER TABLE "notification"."outbox" ADD CONSTRAINT "notification_outbox_topic_check"
	CHECK ("notification"."outbox"."topic" in ('bet_settled','review_pending','freebet_expiring','polymarket_activity'));

-- ------------------------------------------------------------------ favoritos
-- Um favorito por (organização, usuário, carteira). A chave inclui a
-- organização e o usuário porque o limite é POR USUÁRIO: duas contas
-- diferentes, cada uma com seus dez.
CREATE TABLE IF NOT EXISTS "integration"."polymarket_favorite" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid DEFAULT current_setting('app.organization_id', true)::uuid NOT NULL,
	"user_id" text NOT NULL,
	-- A carteira pública, em MINÚSCULAS: a identidade é canônica e `0xAB` e
	-- `0xab` são o mesmo trader. O CHECK impõe a forma de 0x + 40 hex.
	"proxy_wallet" text NOT NULL,
	-- O nome é o que a origem publicou no momento do favored. É um rótulo
	-- HISTÓRICO, não um alias: favoritar não cria nem renomeia trader.
	"user_name" text NOT NULL DEFAULT '',
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "polymarket_favorite_wallet_check" CHECK ("integration"."polymarket_favorite"."proxy_wallet" ~ '^0x[0-9a-f]{40}$'),
	CONSTRAINT "polymarket_favorite_user_not_empty" CHECK (btrim("integration"."polymarket_favorite"."user_id") <> ''),
	CONSTRAINT "polymarket_favorite_name_length" CHECK (char_length("integration"."polymarket_favorite"."user_name") <= 200)
);
--> statement-breakpoint
-- Um trader é favorito UMA vez por usuário. O mesmo índice é o que torna o
-- reenvio idempotente: favoritar duas vezes devolve conflito, e a aplicação
-- trata o conflito como "já era favorito" em vez de criar um segundo registro.
CREATE UNIQUE INDEX IF NOT EXISTS "polymarket_favorite_identity_uidx"
	ON "integration"."polymarket_favorite" USING btree ("organization_id", "user_id", "proxy_wallet");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "polymarket_favorite_user_idx"
	ON "integration"."polymarket_favorite" USING btree ("organization_id", "user_id", "created_at");
--> statement-breakpoint

-- O TETO É DO BANCO. A função serializa as escritas do MESMO usuário com um
-- advisory lock transacional e conta as linhas dentro da transação: com o lock,
-- dois INSERT concorrentes do mesmo usuário são serializados, o segundo contou
-- depois do primeiro decidir, e o décimo primeiro levanta a exceção.
--
-- A primeira versão deste trigger usava `SELECT count(*) ... FOR SHARE`, que o
-- Postgres RECUSA (`FOR SHARE is not allowed with aggregate functions`) — a
-- trava de linha de uma agregação não existe. O advisory lock por usuário é a
-- troca certa: a granularidade é a conta, não a linha, e é ela que resolve a
-- corrida que o teto precisa resolver.
CREATE OR REPLACE FUNCTION "integration"."polymarket_favorite_limit"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
	total integer;
	lock_key bigint;
BEGIN
	-- O lock é derivado do usuário E da organização: duas contas homônimas em
	-- organizações diferentes são usuários diferentes e não se bloqueiam.
	lock_key := ('x' || substr(md5(NEW."organization_id"::text || ':' || NEW."user_id"), 1, 16))::bit(64)::bigint;
	PERFORM pg_advisory_xact_lock(lock_key);
	SELECT count(*)::integer INTO total
	FROM "integration"."polymarket_favorite"
	WHERE "organization_id" = NEW."organization_id" AND "user_id" = NEW."user_id";
	IF total >= 10 THEN
		RAISE EXCEPTION 'FAVORITES_LIMIT_REACHED' USING ERRCODE = '23514';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "polymarket_favorite_limit_trigger" ON "integration"."polymarket_favorite";--> statement-breakpoint
CREATE TRIGGER "polymarket_favorite_limit_trigger"
	BEFORE INSERT ON "integration"."polymarket_favorite"
	FOR EACH ROW EXECUTE FUNCTION "integration"."polymarket_favorite_limit"();

-- ------------------------------------------------- configuração de alerta
-- Uma linha por usuário, e ela é INDEPENDENTE do favorito: a ativação é
-- explícita e nunca é criada junto com um favorito.
CREATE TABLE IF NOT EXISTS "integration"."polymarket_alert_config" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid DEFAULT current_setting('app.organization_id', true)::uuid NOT NULL,
	"user_id" text NOT NULL,
	-- A ATIVAÇÃO. Default DESLIGADO: favoritar não ativa, e a ausência de
	-- linha significa a mesma coisa que `false`.
	"enabled" boolean NOT NULL DEFAULT false,
	-- O limiar do card: US$ 1.000 de atividade LÍQUIDA por janela de 5 min.
	-- `numeric(38, 18)` exato, pelo mesmo motivo da F2-14: um limiar comparado
	-- em ponto flutuante dispararia ou não por arredondamento.
	"threshold" numeric(38, 18) NOT NULL DEFAULT 1000,
	-- O teto de alertas por DIA LOCAL do usuário. O dia é o do fuso dele
	-- (§3.7), e a aplicação é quem o calcula — o banco guarda só o teto.
	"daily_limit" integer NOT NULL DEFAULT 10,
	-- A janela do card, FIXA. O CHECK de igualdade transforma "5 minutos" em
	-- invariante do banco: um segundo produto com janela de 15 min não pode
	-- nascer por um UPDATE acidental.
	"window_minutes" integer NOT NULL DEFAULT 5,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "polymarket_alert_config_user_not_empty" CHECK (btrim("integration"."polymarket_alert_config"."user_id") <> ''),
	CONSTRAINT "polymarket_alert_config_threshold_positive" CHECK ("integration"."polymarket_alert_config"."threshold" > 0),
	CONSTRAINT "polymarket_alert_config_daily_limit_check" CHECK ("integration"."polymarket_alert_config"."daily_limit" between 1 and 200),
	CONSTRAINT "polymarket_alert_config_window_fixed" CHECK ("integration"."polymarket_alert_config"."window_minutes" = 5)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "polymarket_alert_config_user_uidx"
	ON "integration"."polymarket_alert_config" USING btree ("organization_id", "user_id");

-- ------------------------------------------------- janela de atividade
-- A observação por (usuário, trader, janela). Duas linhas na mesma janela com o
-- MESMO instante significam o mesmo dado: o job roda de novo e o `ON CONFLICT`
-- devolve a linha existente em vez de inflar a tabela.
CREATE TABLE IF NOT EXISTS "integration"."polymarket_activity_window" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid DEFAULT current_setting('app.organization_id', true)::uuid NOT NULL,
	"user_id" text NOT NULL,
	"proxy_wallet" text NOT NULL,
	-- O início da janela, já alinhado em UTC. A janela é dado de
	-- AGRUPAMENTO, não de exibição: duas contas em fusos diferentes precisam
	-- cair na mesma janela para que o mesmo evento não conte duas vezes.
	"window_start" timestamp with time zone NOT NULL,
	-- O volume acumulado publicado pela origem no instante da observação: o
	-- que a próxima leitura vai subtrair.
	"volume_observed" numeric(38, 18) NOT NULL,
	-- O instante da OBSERVAÇÃO, distinto do início da janela: é ele que
	-- responde "quando vimos isso" e é dele que sai a latência do alerta.
	"observed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "polymarket_activity_window_wallet_check" CHECK ("integration"."polymarket_activity_window"."proxy_wallet" ~ '^0x[0-9a-f]{40}$'),
	CONSTRAINT "polymarket_activity_window_user_not_empty" CHECK (btrim("integration"."polymarket_activity_window"."user_id") <> ''),
	CONSTRAINT "polymarket_activity_window_observed_after_start" CHECK ("integration"."polymarket_activity_window"."observed_at" >= "integration"."polymarket_activity_window"."window_start")
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "polymarket_activity_window_identity_uidx"
	ON "integration"."polymarket_activity_window" USING btree ("organization_id", "user_id", "proxy_wallet", "window_start");
--> statement-breakpoint
-- O índice do job: ele varre os favoritos do usuário e compara com a última
-- janela gravada de cada trader.
CREATE INDEX IF NOT EXISTS "polymarket_activity_window_wallet_idx"
	ON "integration"."polymarket_activity_window" USING btree ("organization_id", "user_id", "proxy_wallet", "window_start" DESC);

-- ------------------------------------------------- Composite Score (silencioso)
-- A versão é o que torna o histórico confiável: reprocessar a MESMA janela
-- grava a versão seguinte em vez de sobrescrever a anterior, e o índice único
-- (janela, versão) impede duas versões iguais no banco. A linha guarda o que
-- o score AUDA a auditar — a completude que a F2-14 gravou, o hash do conteúdo
-- avaliado e o motivo da recusa — e nenhum campo que o exponha na interface.
CREATE TABLE IF NOT EXISTS "integration"."polymarket_score_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	-- A janela, com os ENUMS OFICIAIS que a F2-15 provou e que o CHECK da F2-14
	-- gravou. Uma categoria fora do enum oficial é recusada na escrita.
	"category" text NOT NULL,
	"time_period" text NOT NULL,
	"order_by" text NOT NULL,
	"version" integer NOT NULL DEFAULT 1,
	-- A completude GRAVADA pela F2-14, copiada no momento do cálculo. Ela é o
	-- que permite saber, depois, sobre qual cobertura o score foi medido.
	"series_status" text NOT NULL,
	-- O SCORE. Anulável de propósito: a recusa grava `null` com o motivo, e
	-- um `0` seria um score legítimo que ninguém calculou.
	"score" numeric(38, 18),
	"eligible" boolean NOT NULL DEFAULT false,
	"reason" text,
	"components" jsonb NOT NULL DEFAULT '[]'::jsonb,
	"traders" integer NOT NULL DEFAULT 0,
	"digest" text NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "polymarket_score_run_category_check" CHECK ("integration"."polymarket_score_run"."category" in ('OVERALL','POLITICS','SPORTS','ESPORTS','CRYPTO','CULTURE','MENTIONS','WEATHER','ECONOMICS','TECH','FINANCE')),
	CONSTRAINT "polymarket_score_run_time_period_check" CHECK ("integration"."polymarket_score_run"."time_period" in ('DAY','WEEK','MONTH','ALL')),
	CONSTRAINT "polymarket_score_run_order_by_check" CHECK ("integration"."polymarket_score_run"."order_by" in ('PNL','VOL')),
	CONSTRAINT "polymarket_score_run_status_check" CHECK ("integration"."polymarket_score_run"."series_status" in ('complete','truncated','partial','unknown')),
	CONSTRAINT "polymarket_score_run_version_positive" CHECK ("integration"."polymarket_score_run"."version" >= 1),
	CONSTRAINT "polymarket_score_run_traders_nonnegative" CHECK ("integration"."polymarket_score_run"."traders" >= 0),
	CONSTRAINT "polymarket_score_run_digest_check" CHECK ("integration"."polymarket_score_run"."digest" ~ '^[0-9a-f]{64}$'),
	-- Um score SEM motivo de recusa é ilegível: a aplicação grava `eligible=false`
	-- com o motivo, e o banco recusa o contrário.
	CONSTRAINT "polymarket_score_run_refusal_check" CHECK (("integration"."polymarket_score_run"."eligible" and "integration"."polymarket_score_run"."reason" is null and "integration"."polymarket_score_run"."score" is not null) or (not "integration"."polymarket_score_run"."eligible" and "integration"."polymarket_score_run"."reason" is not null and "integration"."polymarket_score_run"."score" is null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "polymarket_score_run_version_uidx"
	ON "integration"."polymarket_score_run" USING btree ("category", "time_period", "order_by", "version");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "polymarket_score_run_window_idx"
	ON "integration"."polymarket_score_run" USING btree ("category", "time_period", "order_by", "computed_at" DESC);

-- ----------------------------------------------------------------- isolamento
-- RLS: isolamento por organização, fail-closed sem contexto (`nullif ''` → NULL).
-- As políticas são profundidade para um papel futuro; a defesa efetiva são os
-- predicados explícitos no código, porque o papel de conexão é dono do banco.
-- FORCE continua ausente de propósito: o ciclo de backup/restore roda com um
-- único papel.
ALTER TABLE "integration"."polymarket_favorite" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "organization_isolation" ON "integration"."polymarket_favorite";--> statement-breakpoint
CREATE POLICY "organization_isolation" ON "integration"."polymarket_favorite"
	USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
	WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "integration"."polymarket_alert_config" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "organization_isolation" ON "integration"."polymarket_alert_config";--> statement-breakpoint
CREATE POLICY "organization_isolation" ON "integration"."polymarket_alert_config"
	USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
	WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "integration"."polymarket_activity_window" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "organization_isolation" ON "integration"."polymarket_activity_window";--> statement-breakpoint
CREATE POLICY "organization_isolation" ON "integration"."polymarket_activity_window"
	USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
	WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
