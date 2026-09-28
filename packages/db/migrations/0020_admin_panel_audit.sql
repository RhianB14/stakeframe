-- STK-F2-11 — trilha de auditoria dos acessos ao painel interno do superadmin
-- (Plano Master §7.2).
--
-- Uma linha por TENTATIVA de abrir uma visão do painel, permitida OU negada: a
-- recusa também é evidência. A tabela é global de propósito — o painel é a
-- única superfície que atravessa tenants e a própria trilha não pode depender
-- (nem ser apagada junto) do contexto de uma organização.
--
-- Só o identificador interno de quem tentou, a visão, o desfecho, o id da
-- requisição gerado pelo servidor e o instante. Nenhum e-mail, IP, user-agent,
-- cookie, sessão, corpo de requisição ou conteúdo de usuário.
--
-- Replay-safe: a cadeia de testes reconstrói o schema `core` e replaya a partir
-- da 0005, e o harness de upgrade apaga as últimas migrações antes de reaplicar
-- — a função é OR REPLACE e o trigger é DROP IF EXISTS, então o replay converge.

CREATE TABLE "core"."admin_panel_access" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_user_id" text NOT NULL,
	"view" text NOT NULL,
	"outcome" text NOT NULL,
	"request_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_panel_access_view_check" CHECK ("core"."admin_panel_access"."view" in ('accounts','usage','flags','errors','audit')),
	CONSTRAINT "admin_panel_access_outcome_check" CHECK ("core"."admin_panel_access"."outcome" in ('allowed','denied')),
	CONSTRAINT "admin_panel_access_actor_not_empty" CHECK (btrim("core"."admin_panel_access"."actor_user_id") <> '')
);
--> statement-breakpoint
ALTER TABLE "core"."admin_panel_access" ADD CONSTRAINT "admin_panel_access_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "auth"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "admin_panel_access_created_idx" ON "core"."admin_panel_access" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "admin_panel_access_actor_idx" ON "core"."admin_panel_access" USING btree ("actor_user_id","created_at");--> statement-breakpoint
-- Append-only: a trilha de auditoria é a evidência de quem abriu a superfície de
-- administração; reescrevê-la ou apagá-la anularia a única prova de um abuso.
-- O erro é estável e sanitizado (nenhum dado de linha na mensagem).
CREATE OR REPLACE FUNCTION "core"."immutable_admin_audit"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ADMIN_AUDIT_IMMUTABLE' USING ERRCODE='23514';
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "admin_panel_access_immutable" ON "core"."admin_panel_access";--> statement-breakpoint
CREATE TRIGGER "admin_panel_access_immutable" BEFORE UPDATE OR DELETE ON "core"."admin_panel_access" FOR EACH ROW EXECUTE FUNCTION "core"."immutable_admin_audit"();
