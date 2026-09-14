CREATE TYPE "core"."legal_document_status" AS ENUM('current', 'superseded');--> statement-breakpoint
CREATE TYPE "core"."legal_document_type" AS ENUM('terms_of_use', 'privacy_policy', 'minimum_age');--> statement-breakpoint
CREATE TABLE "core"."consent_record" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"document_id" uuid NOT NULL,
	"doc_type" "core"."legal_document_type" NOT NULL,
	"document_version" text NOT NULL,
	"document_hash" text NOT NULL,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "core"."legal_document" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"doc_type" "core"."legal_document_type" NOT NULL,
	"version" text NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"content_md" text NOT NULL,
	"content_hash" text NOT NULL,
	"text_url" text NOT NULL,
	"required" boolean DEFAULT true NOT NULL,
	"status" "core"."legal_document_status" DEFAULT 'current' NOT NULL,
	"effective_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "legal_document_version_not_empty" CHECK (btrim("core"."legal_document"."version") <> ''),
	CONSTRAINT "legal_document_hash_format" CHECK ("core"."legal_document"."content_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "core"."consent_record" ADD CONSTRAINT "consent_record_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."consent_record" ADD CONSTRAINT "consent_record_document_id_legal_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "core"."legal_document"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "consent_record_user_document_key" ON "core"."consent_record" USING btree ("user_id","document_id");--> statement-breakpoint
CREATE INDEX "consent_record_user_accepted_idx" ON "core"."consent_record" USING btree ("user_id","accepted_at");--> statement-breakpoint
CREATE UNIQUE INDEX "legal_document_type_version_key" ON "core"."legal_document" USING btree ("doc_type","version");--> statement-breakpoint
CREATE INDEX "legal_document_type_status_idx" ON "core"."legal_document" USING btree ("doc_type","status");INSERT INTO "core"."legal_document" ("doc_type", "version", "title", "summary", "content_md", "content_hash", "text_url", "required", "status", "effective_at") VALUES ('terms_of_use', '1.0.0-draft', 'Termos de Uso (provisório)', 'Rascunho técnico dos Termos de Uso do Stakeframe. Conteúdo provisório; a versão jurídica aprovada substituirá este documento em nova versão com novo aceite.', $stk$# Termos de Uso — Stakeframe (PROVISÓRIO / DRAFT v1.0.0-draft)

> **AVISO IMPORTANTE — DOCUMENTO PROVISÓRIO.** Este texto é um rascunho técnico de
> estrutura, **não é redação jurídica aprovada** e não constitui parecer jurídico. Ele
> existe apenas para viabilizar o fluxo de consentimento versionado durante o beta
> fechado. A substituição por uma versão revisada e aprovada por profissional do direito
> é **obrigatória antes de qualquer lançamento pago**, por meio de uma nova versão no
> catálogo de documentos (com novo aceite dos usuários).

**Versão:** 1.0.0-draft · **Vigência:** 14/09/2026 · **Idioma:** português (Brasil)

## 1. O que é o Stakeframe

O Stakeframe é um aplicativo pessoal de organização e acompanhamento de apostas. Ele
registra informações fornecidas pelo próprio usuário (como bilhetes, valores e datas),
organiza relatórios e oferece funcionalidades auxiliares. O Stakeframe **não realiza
apostas, não intermedia apostas e não movimenta dinheiro** em nome do usuário.

## 2. Conta e acesso

- O acesso durante o beta fechado é **exclusivo por convite**.
- O usuário é responsável por manter a confidencialidade das suas credenciais.
- Cada usuário recebe uma organização técnica isolada; não há compartilhamento de dados
  entre organizações nesta fase.

## 3. Uso aceitável

- Utilizar o aplicativo apenas para finalidades pessoais e legítimas.
- Não tentar acessar dados de outras pessoas, burlar mecanismos de segurança ou
  sobrecarregar o serviço.
- Não inserir conteúdo ilícito.

## 4. Beta gratuito e ausência de garantias

Durante o beta o serviço é oferecido **gratuitamente, no estado em que se encontra**,
sem garantias de disponibilidade, exatidão de cálculos auxiliares ou continuidade. O
Stakeframe não se responsabiliza por decisões de aposta tomadas pelo usuário.

## 5. Limitação de responsabilidade (provisória)

Na máxima extensão permitida pela legislação aplicável — e conforme redação que será
definida na revisão jurídica — o Stakeframe não responde por lucros cessantes, perdas
indiretas ou danos decorrentes do uso das informações exibidas.

## 6. Alterações destes termos

Alterações materiais geram uma **nova versão** deste documento. A versão vigente será
sempre exibida para novo aceite antes da continuidade do acesso.

## 7. Encerramento

O usuário pode encerrar o uso a qualquer momento (saída da conta). O beta pode ser
descontinuado ou alterado a qualquer momento, com aviso razoável.

## 8. Lei aplicável e foro

*A definir na revisão jurídica, considerando a legislação brasileira aplicável.*

## 9. Contato

Canal de contato durante o beta: definido no aplicativo.
$stk$, 'b78908f9fd34769c016462b23495add43cda3183af6c273b937c87621ca570eb', '/api/v1/legal/documents/terms_of_use/1.0.0-draft', true, 'current', '2026-09-14T03:00:00Z');
--> statement-breakpoint
INSERT INTO "core"."legal_document" ("doc_type", "version", "title", "summary", "content_md", "content_hash", "text_url", "required", "status", "effective_at") VALUES ('privacy_policy', '1.0.0-draft', 'Política de Privacidade (provisório)', 'Rascunho técnico da Política de Privacidade (LGPD): dados tratados, finalidades, retenção, compartilhamento e direitos do titular.', $stk$# Política de Privacidade — Stakeframe (PROVISÓRIO / DRAFT v1.0.0-draft)

> **AVISO IMPORTANTE — DOCUMENTO PROVISÓRIO.** Este texto é um rascunho técnico de
> estrutura, **não é redação jurídica aprovada** e não constitui parecer jurídico. Ele
> existe apenas para viabilizar o fluxo de consentimento versionado durante o beta
> fechado. A substituição por uma versão revisada e aprovada por profissional do direito
> é **obrigatória antes de qualquer lançamento pago**, por meio de uma nova versão no
> catálogo de documentos (com novo aceite dos usuários).

**Versão:** 1.0.0-draft · **Vigência:** 14/09/2026 · **Idioma:** português (Brasil)

## 1. Quais dados tratamos

- **Conta:** identificador de autenticação (e-mail e nome fornecidos no cadastro ou pelo
  provedor Google), status de verificação de e-mail e registros de sessão técnicos.
- **Conteúdo do produto:** registros que você insere ou importa, como bilhetes de apostas,
  valores, datas, anotações e imagens enviadas para leitura.
- **Consentimentos:** registro versionado e auditável dos aceites destes documentos.
- **Registros técnicos:** logs operacionais sanitizados para segurança e diagnóstico.

## 2. Finalidades

- Operar sua conta, sua organização técnica isolada e os recursos contratados.
- Organizar e processar as informações que você registra (inclusive leitura auxiliar de
  imagens de bilhetes, quando utilizada).
- Enviar mensagens operacionais (verificação de e-mail, recuperação de senha, alertas de
  segurança da conta).
- Prevenir abuso e manter a segurança do serviço.

## 3. Compartilhamento com operadores

Durante o beta, o serviço utiliza operadores técnicos estritamente necessários, como:
provedor de nuvem e borda (Cloudflare), banco de dados na infraestrutura contratada,
provedor de e-mail transacional (Resend), autenticação Google (quando você opta por ela)
e provedores de IA para funções auxiliares de organização/leitura, quando ativadas.
Cada operador recebe apenas o mínimo necessário para a função. **Não vendemos dados
pessoais.**

## 4. Retenção

- Imagens de bilhetes são privadas e retidas por até 90 dias, salvo exclusão anterior.
- Registros técnicos são mantidos pelo período necessário à segurança e ao diagnóstico.
- Registros de consentimento são mantidos para comprovação dos aceites.
- Prazos definitivos serão consolidados na revisão jurídica.

## 5. Seus direitos (LGPD)

Nos termos da Lei Geral de Proteção de Dados (Lei nº 13.709/2018), você pode solicitar:
confirmação de tratamento, acesso, correção, portabilidade (exportação em JSON/CSV),
informação sobre compartilhamento e eliminação, observadas as hipóteses legais de
retenção. Pedidos são atendidos pelos canais do aplicativo.

## 6. Segurança

Adotamos controles técnicos como isolamento por organização, sessões de curta duração,
verificação de e-mail, transporte HTTPS e registro mínimo de dados sensíveis. Nenhum
sistema é infalível; incidentes relevantes serão comunicados conforme a legislação.

## 7. Alterações desta política

Alterações materiais geram uma **nova versão** deste documento, com novo aceite.

## 8. Contato

Canal de contato durante o beta: definido no aplicativo (encarregado de dados a ser
formalmente designado na revisão jurídica).
$stk$, 'b732963fa443f265936773d1d378198146ddef37e3df8f4dc065f8dac26138d2', '/api/v1/legal/documents/privacy_policy/1.0.0-draft', true, 'current', '2026-09-14T03:00:00Z');
--> statement-breakpoint
INSERT INTO "core"."legal_document" ("doc_type", "version", "title", "summary", "content_md", "content_hash", "text_url", "required", "status", "effective_at") VALUES ('minimum_age', '1.0.0-draft', 'Declaração de Idade Mínima (provisório)', 'Declaração de idade mínima (18+): autodeclaração obrigatória para uso do Stakeframe durante o beta.', $stk$# Declaração de Idade Mínima — Stakeframe (PROVISÓRIO / DRAFT v1.0.0-draft)

> **AVISO IMPORTANTE — DOCUMENTO PROVISÓRIO.** Este texto é um rascunho técnico de
> estrutura, **não é redação jurídica aprovada** e não constitui parecer jurídico. Ele
> existe apenas para viabilizar o fluxo de consentimento versionado durante o beta
> fechado. A substituição por uma versão revisada e aprovada por profissional do direito
> é **obrigatória antes de qualquer lançamento pago**, por meio de uma nova versão no
> catálogo de documentos (com novo aceite dos usuários).

**Versão:** 1.0.0-draft · **Vigência:** 14/09/2026 · **Idioma:** português (Brasil)

## 1. Declaração

Ao aceitar este documento, você declara, sob sua responsabilidade, que:

- tem **18 (dezoito) anos ou mais**;
- possui capacidade legal para utilizar este aplicativo;
- não utilizará o Stakeframe para qualquer finalidade ilícita, inclusive relacionada a
  apostas proibidas para menores de idade.

## 2. Natureza do Stakeframe

O Stakeframe é uma ferramenta de organização e acompanhamento **para adultos**. Ele não
realiza apostas, não intermedia valores e não incentiva a participação em jogos de azar.
Se você não atende ao requisito de idade, **não continue** e encerre o uso.

## 3. Verificação

Durante o beta, a idade é **autodeclarada** nesta etapa. Mecanismos adicionais de
verificação poderão ser exigidos em etapas posteriores, conforme a legislação aplicável
e a revisão jurídica.

## 4. Consequências da declaração falsa

A declaração falsa pode resultar no encerramento do acesso, observadas as regras do beta
e a legislação aplicável.
$stk$, 'd84990c2e1b569d398cdd6349d5d7ffff0b7460be78c58ee24d630b623d1015c', '/api/v1/legal/documents/minimum_age/1.0.0-draft', true, 'current', '2026-09-14T03:00:00Z');
