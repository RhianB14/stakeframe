-- STK-F2-06 — extração fail-closed: registro sanitizado, consumo por
-- apresentação e entrada de circuit breaker (global, diário e por usuário).
--
-- Esta migração não guarda conteúdo de bilhete. A tabela de auditoria de
-- extração aceita a ESTRUTURA sanitizada, a versão do pipeline, hashes, a
-- categoria de erro e uso/resultado — e o schema de aplicação é strictObject,
-- então não existe coluna onde prompt ou resposta bruta caberiam. O CHECK do
-- banco é a segunda barreira: ele reage ao JSON, e o JSON que chega já é
-- sanitizado; a garantia primária é a ausência de campo livre.
--
-- Três decisões deliberadas:
--
--  - A quota é contada por APRESENTAÇÃO, não por chamada. `integration.
--    ai_usage_day` já existia contando requisições no momento da reserva da
--    tentativa (`inbox.claim`), o que é o oposto do card: uma falha técnica
--    gastava cota sem nada ter sido mostrado. A 0024 corrige o sinal — passa a
--    contar `presented` (e `candidates_pending`) — e a 0010 já trende
--    `ai_usage_day` como infraestrutura global, sem RLS, o que é o certo: a
--    cota é compartilhada por todos os tenants e nenhum deles pode apagá-la.
--
--  - O consumo por ITEM é gravado uma vez só. O índice único parcial sobre
--    `outcome_presented` garante no BANCO que um bilhete não pode ser
--    contabilizado duas vezes, mesmo que o worker repita a debitada; a
--    idempotência não depende de disciplina da aplicação.
--
--  - O circuit breaker nasce como BASE ESTRUTURAL: o estado é gravado, o
--    tempo de recuperação é contido, e a porta é fail-closed. A STK-F2-13
--    complementa a política (limiares e janela), sem alterar a forma.
--
-- Forward-only e replay-safe (IF NOT EXISTS / DROP ... IF EXISTS / DO $$ ... END
-- $$), no mesmo padrão da 0010, da 0011, da 0021 e da 0023. Esta migração é
-- LOCAL: nada é executado em produção sem o fluxo de autorização, backup e
-- recuperação do runbook.

-- --------------------------------------------------------------- colunas novas
-- Versão do pipeline: com qual regra a estrutura foi produzida. Viaja junto do
-- item, então a auditoria responde meses depois sem depender do código atual.
ALTER TABLE "integration"."inbox" ADD COLUMN IF NOT EXISTS "extraction_pipeline_version" text;--> statement-breakpoint
-- Categorias de erro e desfecho, como CODES. O conteúdo bruto da falha nunca é
-- gravado: o nome do código é a informação inteira.
ALTER TABLE "integration"."inbox" ADD COLUMN IF NOT EXISTS "extraction_error_category" text;--> statement-breakpoint
ALTER TABLE "integration"."inbox" ADD COLUMN IF NOT EXISTS "extraction_outcome" text;--> statement-breakpoint
-- Hashes: o prompt e a resposta entram como SHA-256, nunca como texto. O
-- sha256 da imagem é a identidade determinística que a 0023 já gravou.
ALTER TABLE "integration"."inbox" ADD COLUMN IF NOT EXISTS "extraction_prompt_sha256" text;--> statement-breakpoint
ALTER TABLE "integration"."inbox" ADD COLUMN IF NOT EXISTS "extraction_response_sha256" text;--> statement-breakpoint
-- Instante em que a extração foi APRESENTADA para revisão. É a verdade da
-- quota: a unidade é contada aqui, mesmo que o usuário descarte depois.
ALTER TABLE "integration"."inbox" ADD COLUMN IF NOT EXISTS "extraction_presented_at" timestamp with time zone;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='inbox_extraction_pipeline_version_check' AND conrelid='integration.inbox'::regclass) THEN
	ALTER TABLE "integration"."inbox" ADD CONSTRAINT "inbox_extraction_pipeline_version_check" CHECK ("integration"."inbox"."extraction_pipeline_version" is null or "integration"."inbox"."extraction_pipeline_version" ~ '^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$');
END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='inbox_extraction_error_category_check' AND conrelid='integration.inbox'::regclass) THEN
	ALTER TABLE "integration"."inbox" ADD CONSTRAINT "inbox_extraction_error_category_check" CHECK ("integration"."inbox"."extraction_error_category" is null or "integration"."inbox"."extraction_error_category" in ('uncertain_timeout','uncertain_network','confirmed_rate_limited','confirmed_budget','confirmed_auth','confirmed_request','confirmed_response','confirmed_provider','refused_quota'));
END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='inbox_extraction_outcome_check' AND conrelid='integration.inbox'::regclass) THEN
	ALTER TABLE "integration"."inbox" ADD CONSTRAINT "inbox_extraction_outcome_check" CHECK ("integration"."inbox"."extraction_outcome" is null or "integration"."inbox"."extraction_outcome" in ('presented','candidates_pending','uncertain','confirmed_failure','refused_quota'));
END IF; END $$;--> statement-breakpoint
-- Coerência: a apresentação é o que gera a cota, então presented_at existe
-- exatamente nos desfechos que contam unidade. presented e candidates_pending
-- PRESENTAM; os outros três deixam o item apenas para preenchimento manual.
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='inbox_extraction_presented_coherence' AND conrelid='integration.inbox'::regclass) THEN
	ALTER TABLE "integration"."inbox" ADD CONSTRAINT "inbox_extraction_presented_coherence" CHECK (
		("integration"."inbox"."extraction_outcome" in ('presented','candidates_pending')) = ("integration"."inbox"."extraction_presented_at" is not null)
	);
END IF; END $$;--> statement-breakpoint
-- Um desfecho APRESENTADO não carrega categoria de erro: apresentou-se
-- estrutura, não um erro. Vale para os dois desfechos de apresentação —
-- `presented` e `candidates_pending` — e `candidates_pending` não é exceção:
-- dois resultados válidos igualmente bons é ambiguidade, não defeito.
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='inbox_extraction_error_coherence' AND conrelid='integration.inbox'::regclass) THEN
	ALTER TABLE "integration"."inbox" ADD CONSTRAINT "inbox_extraction_error_coherence" CHECK (
		("integration"."inbox"."extraction_outcome" in ('presented','candidates_pending'))
		OR ("integration"."inbox"."extraction_error_category" is not null)
	);
END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='inbox_extraction_hash_check' AND conrelid='integration.inbox'::regclass) THEN
	ALTER TABLE "integration"."inbox" ADD CONSTRAINT "inbox_extraction_hash_check" CHECK (
		("integration"."inbox"."extraction_prompt_sha256" is null or "integration"."inbox"."extraction_prompt_sha256" ~ '^[a-f0-9]{64}$')
		AND ("integration"."inbox"."extraction_response_sha256" is null or "integration"."inbox"."extraction_response_sha256" ~ '^[a-f0-9]{64}$')
	);
END IF; END $$;--> statement-breakpoint

-- ------------------------------------------------- auditoria de extração (RLS)
-- Uma linha por ITEM e por chamada concluída, com o registro sanitizado. É a
-- prova de que nada bruto foi persistido: `sanitized`, `candidates` e `usage`
-- são jsonb, e o schema que os valida é strictObject — um payload com
-- `rawResponse` ou `content` é rejeitado na borda.
--
-- `extraction` guarda a EVIDÊNCIA sanitizada (a mesma estrutura que já vive em
-- `integration.inbox.extraction`), e `candidates` guarda o caso de DOIS
-- resultados válidos: ambos são apresentados e `selected` fica nulo, porque
-- escolher um é ato do usuário, não do modelo.
CREATE TABLE IF NOT EXISTS "integration"."extraction_audit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"inbox_id" uuid NOT NULL,
	-- Versão do pipeline: com qual regra a estrutura foi produzida.
	"pipeline_version" text NOT NULL,
	-- presented | candidates_pending | uncertain | confirmed_failure | refused_quota.
	"outcome" text NOT NULL,
	-- Categoria do erro (código fechado), ou NULL quando a extração foi apresentada.
	"error_category" text,
	-- Estrutura sanitizada; NULL quando nada foi extraído. Nunca texto bruto.
	"sanitized" jsonb,
	-- Dois resultados válidos, ambos apresentados; NULL no caso comum.
	"candidates" jsonb,
	-- Nenhum resultado foi escolhido automaticamente — a escolha é do usuário.
	"selected" text,
	-- Uso declarado pelo fornecedor: inteiros, nunca texto.
	"usage" jsonb,
	-- Hashes (prompt, resposta, imagem). O conteúdo, nunca.
	"prompt_sha256" text,
	"response_sha256" text,
	"image_sha256" text,
	"model" text,
	"elapsed_ms" integer,
	-- Verdadeiro exatamente nos desfechos que contam unidade de cota.
	"outcome_presented" boolean NOT NULL DEFAULT false,
	"presented_at" timestamp with time zone,
	-- Resultado do circuito: por que a chamada foi recusada, se foi.
	"breaker_scope" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "extraction_audit_outcome_check" CHECK ("integration"."extraction_audit"."outcome" in ('presented','candidates_pending','uncertain','confirmed_failure','refused_quota')),
	CONSTRAINT "extraction_audit_error_category_check" CHECK ("integration"."extraction_audit"."error_category" is null or "integration"."extraction_audit"."error_category" in ('uncertain_timeout','uncertain_network','confirmed_rate_limited','confirmed_budget','confirmed_auth','confirmed_request','confirmed_response','confirmed_provider','refused_quota')),
	CONSTRAINT "extraction_audit_breaker_scope_check" CHECK ("integration"."extraction_audit"."breaker_scope" is null or "integration"."extraction_audit"."breaker_scope" in ('global','daily','user')),
	CONSTRAINT "extraction_audit_presented_check" CHECK (
		("integration"."extraction_audit"."outcome" in ('presented','candidates_pending')) = ("integration"."extraction_audit"."outcome_presented")
		AND ("integration"."extraction_audit"."outcome" in ('presented','candidates_pending')) = ("integration"."extraction_audit"."presented_at" is not null)
	),
	-- presented com categoria de erro é incoerente: apresentou-se estrutura.
	-- O mesmo vale para candidates_pending — dois resultados válidos igualmente
	-- bons é ambiguidade, não defeito, então não recebe categoria.
	CONSTRAINT "extraction_audit_error_coherence" CHECK ("integration"."extraction_audit"."outcome" not in ('presented','candidates_pending') or "integration"."extraction_audit"."error_category" is null),
	-- Os dois candidatos existem exatamente em candidates_pending, e NENHUM
	-- escolhido: o desfecho ambíguo é para revisão, não para gravação automática.
	CONSTRAINT "extraction_audit_candidates_check" CHECK (
		(("integration"."extraction_audit"."outcome" = 'candidates_pending') = ("integration"."extraction_audit"."candidates" is not null))
		AND ("integration"."extraction_audit"."outcome" = 'candidates_pending' or "integration"."extraction_audit"."selected" is null)
	),
	-- Hashes em hexadecimal canônico; nada de texto livre no lugar de hash.
	CONSTRAINT "extraction_audit_hash_check" CHECK (
		("integration"."extraction_audit"."prompt_sha256" is null or "integration"."extraction_audit"."prompt_sha256" ~ '^[a-f0-9]{64}$')
		AND ("integration"."extraction_audit"."response_sha256" is null or "integration"."extraction_audit"."response_sha256" ~ '^[a-f0-9]{64}$')
		AND ("integration"."extraction_audit"."image_sha256" is null or "integration"."extraction_audit"."image_sha256" ~ '^[a-f0-9]{64}$')
	),
	CONSTRAINT "extraction_audit_elapsed_check" CHECK ("integration"."extraction_audit"."elapsed_ms" is null or ("integration"."extraction_audit"."elapsed_ms" >= 0 and "integration"."extraction_audit"."elapsed_ms" <= 3600000)),
	CONSTRAINT "extraction_audit_organization_id_id_idx" UNIQUE("organization_id","id"),
	CONSTRAINT "extraction_audit_inbox_fk" FOREIGN KEY ("organization_id","inbox_id") REFERENCES "integration"."inbox"("organization_id","id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
-- RLS fail-closed: sem contexto de organização a expressão não casa nenhuma
-- linha, e tanto a leitura quanto a escrita são recusadas. Mesma fronteira das
-- tabelas privadas de `finance` e `integration`.
ALTER TABLE "integration"."extraction_audit" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "organization_isolation" ON "integration"."extraction_audit";--> statement-breakpoint
CREATE POLICY "organization_isolation" ON "integration"."extraction_audit"
  USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
-- Um item pode ter várias extrações (tentativas, retries explícitos), mas só
-- pode ser CONTABILIZADO uma vez: o índice parcial é o que garante isso no
-- banco, sem depender de disciplina da aplicação.
CREATE UNIQUE INDEX IF NOT EXISTS "extraction_audit_presented_idx" ON "integration"."extraction_audit" USING btree ("organization_id","inbox_id") WHERE "integration"."extraction_audit"."outcome_presented";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "extraction_audit_inbox_idx" ON "integration"."extraction_audit" USING btree ("organization_id","inbox_id","created_at" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "extraction_audit_outcome_idx" ON "integration"."extraction_audit" USING btree ("outcome","created_at" DESC);

-- ----------------------------------------------- circuit breaker (base global)
-- O breaker é infraestrutura GLOBAL, como `ai_usage_day` e `cursor`: a falha do
-- fornecedor não é da organização, e nenhuma organização pode reabri-lo. Por isso
-- este caso NÃO recebe RLS — o predicado de organização seria uma falsa
-- fronteira, porque o estado precisa ser único e visível para todos.
--
-- `scope_key` é o que separa os três escopos: 'global', 'daily' e o id do
-- usuário. `user_id` é NULL fora do escopo de usuário, enforced pelo CHECK.
CREATE TABLE IF NOT EXISTS "integration"."ai_circuit_breaker" (
	"scope" text NOT NULL,
	"scope_key" text NOT NULL,
	-- closed (passa) | open (recusa chamada paga).
	"state" text NOT NULL DEFAULT 'closed',
	-- Falhas CONFIRMADAS que abriram o circuito. Falha incerta NÃO conta: ela
	-- pode ter custado trabalho ao fornecedor, mas não é recusa do serviço.
	"consecutive_confirmed_failures" integer NOT NULL DEFAULT 0,
	"opened_at" timestamp with time zone,
	-- Fim da recuperação, já contido (a STK-F2-13 define a janela).
	"recovers_at" timestamp with time zone,
	-- Última categoria de erro que atingiu o circuito (código, não conteúdo).
	"last_error_category" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_circuit_breaker_pk" PRIMARY KEY ("scope","scope_key"),
	CONSTRAINT "ai_circuit_breaker_scope_check" CHECK ("integration"."ai_circuit_breaker"."scope" in ('global','daily','user')),
	CONSTRAINT "ai_circuit_breaker_state_check" CHECK ("integration"."ai_circuit_breaker"."state" in ('closed','open')),
	-- O escopo é a própria chave: 'global' e 'daily' são singletons e 'user'
	-- exige o usuário identificado.
	CONSTRAINT "ai_circuit_breaker_key_check" CHECK (
		("integration"."ai_circuit_breaker"."scope" = 'user' and "integration"."ai_circuit_breaker"."scope_key" is not null)
		OR ("integration"."ai_circuit_breaker"."scope" in ('global','daily') and "integration"."ai_circuit_breaker"."scope_key" = "integration"."ai_circuit_breaker"."scope")
	),
	CONSTRAINT "ai_circuit_breaker_failures_check" CHECK ("integration"."ai_circuit_breaker"."consecutive_confirmed_failures" >= 0),
	-- Estado e carimbos coerentes: aberto tem marca de abertura, fechado não.
	CONSTRAINT "ai_circuit_breaker_state_coherence" CHECK (
		("integration"."ai_circuit_breaker"."state" = 'open') = ("integration"."ai_circuit_breaker"."opened_at" is not null)
	),
	CONSTRAINT "ai_circuit_breaker_error_category_check" CHECK ("integration"."ai_circuit_breaker"."last_error_category" is null or "integration"."ai_circuit_breaker"."last_error_category" in ('uncertain_timeout','uncertain_network','confirmed_rate_limited','confirmed_budget','confirmed_auth','confirmed_request','confirmed_response','confirmed_provider','refused_quota'))
);

-- ------------------------------------------------- quota contada por apresentação
-- `integration.ai_usage_day` contava requisições na reserva da tentativa
-- (`inbox.claim`), o que consumia cota em falha técnica — o oposto do card. A
-- 0024 troca o sinal: as colunas passam a contar extrações APRESENTADAS.
--
-- A tabela é global e sem RLS desde a 0010 (é infraestrutura do worker), e os
-- CHECKes abaixo rejeitam o sinal antigo, então um valor não-negativo com o
-- nome antigo é impossível: a semântica do dado é a apresentação, e ela é
-- imposta pelo banco, não por convenção.
ALTER TABLE "integration"."ai_usage_day" ADD COLUMN IF NOT EXISTS "presented" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "integration"."ai_usage_day" ADD COLUMN IF NOT EXISTS "uncertain" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "integration"."ai_usage_day" ADD COLUMN IF NOT EXISTS "failed" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "integration"."ai_usage_day" ADD COLUMN IF NOT EXISTS "refused" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='ai_usage_presented_nonnegative' AND conrelid='integration.ai_usage_day'::regclass) THEN
	ALTER TABLE "integration"."ai_usage_day" ADD CONSTRAINT "ai_usage_presented_nonnegative" CHECK ("integration"."ai_usage_day"."presented" >= 0 AND "integration"."ai_usage_day"."uncertain" >= 0 AND "integration"."ai_usage_day"."failed" >= 0 AND "integration"."ai_usage_day"."refused" >= 0);
END IF; END $$;--> statement-breakpoint
-- Teto global do dia, estrutural e explícito: nenhuma chamada nova é preparada
-- quando as apresentações do dia já igualaram o teto. A STK-F2-13 ajusta os
-- valores; a porta, aqui, é a mesma.
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='ai_usage_day_format' AND conrelid='integration.ai_usage_day'::regclass) THEN
	ALTER TABLE "integration"."ai_usage_day" ADD CONSTRAINT "ai_usage_day_format" CHECK ("integration"."ai_usage_day"."day" ~ '^\d{4}-\d{2}-\d{2}$');
END IF; END $$;
