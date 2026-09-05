# Guia de desenvolvimento

## Pré-requisitos

| Ferramenta | Versão        | Observação                                          |
| ---------- | ------------- | --------------------------------------------------- |
| Node.js    | v24.20.0      | Fixado em `.nvmrc`; CI usa exatamente esta versão   |
| pnpm       | 11.24.0       | Declarado em `packageManager`; corepack pode ativar |
| Git        | 2.x           | Identity configurada para commits                   |
| Docker     | qualquer 29.x | Necessário apenas em etapas futuras                 |

> Pendência conhecida: o ambiente local atual roda Node v22.23.2. Alinhar para
> v24.20.0 (nvm-windows, fnm ou volta). A CI já usa a versão correta.

## Setup

```bash
pnpm install
```

## Comandos

| Comando             | O que faz                                     |
| ------------------- | --------------------------------------------- |
| `pnpm format:check` | Verifica formatação (CI executa este comando) |
| `pnpm format`       | Corrige formatação                            |

## Fluxo de trabalho

1. Crie uma branch a partir da `main` atualizada: `feat/...`, `fix/...` ou
   `chore/...`.
2. Faça alterações com commits convencionais
   (`feat:`, `fix:`, `chore:`, `docs:`, `ci:`...).
3. Rode `pnpm format:check` antes do push.
4. Abra a PR para `main`. A CI executa o `format-check`.
5. O merge é autorizado pelo Codex conforme [docs/GOVERNANCE.md](GOVERNANCE.md).

Regras:

- Push direto na `main` é bloqueado pela proteção da branch.
- Somente squash merge; a branch é excluída após o merge.
- Sem force-push e sem alterar histórico de PRs já revisadas sem nova
  autorização.
- Segredos e valores reais de ambiente nunca entram no repositório
  (`.env*` está ignorado, exceto `.env.example`).

## Versionamento de documentos

- Decisões técnicas: [docs/DECISIONS.md](DECISIONS.md).
- Arquitetura (estado real vs. meta): [docs/ARCHITECTURE.md](ARCHITECTURE.md).
- Governança e autorizações: [docs/GOVERNANCE.md](GOVERNANCE.md).
- Progresso do M0: [docs/M0-CHECKLIST.md](M0-CHECKLIST.md).
