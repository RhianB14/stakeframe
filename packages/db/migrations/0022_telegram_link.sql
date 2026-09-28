-- STK-F2-04 — vínculo entre conta Telegram e usuário: deep link de uso único com
-- expiração de cinco minutos, confirmação no site, unicidade global da conta
-- Telegram, revogação e relink auditados.
--
-- O transporte continua sendo o polling do worker existente: nenhum webhook e
-- nenhum serviço novo (Plano Master §8.2).
--
-- Duas fronteiras distintas, deliberadamente:
--  - `core.telegram_link_request` é artefato GLOBAL e temporário. Existe só
--    enquanto o deep link está vivo, é resolvido exclusivamente pelo SHA-256 do
--    token e nunca carrega nome, e-mail, organização ou conteúdo — o mesmo papel
--    de `core.beta_invitation`, e por isso NÃO recebe RLS: a resolução por hash
--    já é a fronteira, e o usuário nunca escolhe organização aqui.
--  - `core.telegram_link` é o vínculo DURADOURO e privado: uma conta Telegram
--    por usuário, escopado pela organização (RLS fail-closed) e removido em
--    cascata quando a organização é apagada (o purge da STK-F1-08).
--
-- A unicidade GLOBAL da conta Telegram é garantida por ÍNDICE PARCIAL sobre
-- `state = 'active'`, nunca por checagem de aplicação: como a RLS esconde as
-- linhas de outra organização, só o índice enxerga o conflito entre
-- organizações. Duas linhas revogadas podem repetir o mesmo id (a trilha de
-- auditoria), mas nunca dois vínculos ativos.
CREATE TYPE "core"."telegram_link_request_state" AS ENUM('pending', 'claimed', 'consumed', 'expired', 'revoked');--> statement-breakpoint
CREATE TYPE "core"."telegram_link_state" AS ENUM('active', 'revoked');--> statement-breakpoint
-- Username público do bot (singleton): o worker resolve por `getMe` e a API lê
-- para montar `https://t.me/<bot>?start=<token>`. É informação pública por
-- natureza (o Telegram publica o username na URL do bot) e por isso vive no
-- banco, e não no repositório: ninguém digita o valor. Ausente = deep link
-- indisponível e a API falha fechada. Sem RLS — é infraestrutura global.
CREATE TABLE "core"."telegram_bot" (
	"id" text PRIMARY KEY DEFAULT 'default' NOT NULL,
	"username" text NOT NULL,
	"resolved_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "telegram_bot_id_check" CHECK ("core"."telegram_bot"."id" = 'default'),
	CONSTRAINT "telegram_bot_username_format" CHECK ("core"."telegram_bot"."username" ~ '^[A-Za-z0-9_]{5,32}$')
);
--> statement-breakpoint
CREATE TABLE "core"."telegram_link" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"telegram_user_id" bigint NOT NULL,
	"state" "core"."telegram_link_state" DEFAULT 'active' NOT NULL,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "telegram_link_telegram_id_check" CHECK ("core"."telegram_link"."telegram_user_id" > 0),
	CONSTRAINT "telegram_link_revocation_check" CHECK (("core"."telegram_link"."state" = 'revoked') = ("core"."telegram_link"."revoked_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "core"."telegram_link_request" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"state" "core"."telegram_link_request_state" DEFAULT 'pending' NOT NULL,
	"telegram_user_id" bigint,
	"expires_at" timestamp with time zone NOT NULL,
	"claimed_at" timestamp with time zone,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "telegram_link_request_ttl_check" CHECK ("core"."telegram_link_request"."expires_at" > "core"."telegram_link_request"."created_at"),
	CONSTRAINT "telegram_link_request_telegram_id_check" CHECK ("core"."telegram_link_request"."telegram_user_id" is null or "core"."telegram_link_request"."telegram_user_id" > 0)
);
--> statement-breakpoint
ALTER TABLE "core"."telegram_link" ADD CONSTRAINT "telegram_link_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "core"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."telegram_link" ADD CONSTRAINT "telegram_link_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."telegram_link_request" ADD CONSTRAINT "telegram_link_request_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "telegram_link_active_telegram_id_key" ON "core"."telegram_link" USING btree ("telegram_user_id") WHERE "core"."telegram_link"."state" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "telegram_link_active_user_id_key" ON "core"."telegram_link" USING btree ("user_id") WHERE "core"."telegram_link"."state" = 'active';--> statement-breakpoint
CREATE INDEX "telegram_link_organization_idx" ON "core"."telegram_link" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "telegram_link_request_token_hash_key" ON "core"."telegram_link_request" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "telegram_link_request_user_state_idx" ON "core"."telegram_link_request" USING btree ("user_id","state","expires_at");
--> statement-breakpoint

-- Fail-closed: sem contexto de organização (`current_setting` nulo) a expressão
-- não casa nenhuma linha e a escrita é recusada pelo WITH CHECK — a mesma
-- fronteira usada pelas tabelas privadas de `finance` e `integration`.
ALTER TABLE "core"."telegram_link" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "organization_isolation" ON "core"."telegram_link";
CREATE POLICY "organization_isolation" ON "core"."telegram_link"
  USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);