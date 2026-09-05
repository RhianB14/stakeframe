# Guia de desenvolvimento

## Pré-requisitos

| Ferramenta | Versão        | Observação                                        |
| ---------- | ------------- | ------------------------------------------------- |
| Node.js    | v24.20.0      | Fixado em `.nvmrc`; CI usa exatamente esta versão |
| pnpm       | 11.24.0       | Declarado em `packageManager`                     |
| Git        | 2.x           | Identity configurada para commits                 |
| Docker     | qualquer 29.x | Necessário apenas em etapas futuras               |

## Runtime isolado do projeto (Windows)

O runtime do sistema/Hermes usa Node v26.7.0 e o `pnpm.ps1` do PATH resolve o
`node.exe` do próprio Hermes — o projeto **não deve depender do PATH global**.
A execução correta é feita com ferramentas isoladas em `dev\tools\stakeframe`:

- `node.exe` v24.20.0 — zip oficial do nodejs.org, SHA-256 conferido contra o
  `SHASUMS256.txt` oficial da distribuição.
- `pnpm.exe` 11.24.0 — binário standalone oficial da release do GitHub do
  pnpm (asset `pnpm-win32-x64.zip`); binário obtido da release oficial e
  validado funcionalmente. Não foi realizada verificação independente de
  checksum do pnpm.

### Procedimento reproduzível

1. Baixar `node-v24.20.0-win-x64.zip` e `SHASUMS256.txt` de
   `https://nodejs.org/dist/v24.20.0/` para `dev\tools\stakeframe\` e conferir
   o SHA-256 do zip contra o `SHASUMS256.txt`.
2. Extrair para `dev\tools\stakeframe\node-v24.20.0-win-x64\`.
3. Baixar `pnpm-win32-x64.zip` da release `v11.24.0` do pnpm no GitHub e
   extrair para `dev\tools\stakeframe\pnpm\` (contém `pnpm.exe`).
4. Em cada sessão, preceder o PATH (git-bash):
   ```bash
   export PATH="/c/Users/Rhian Batista/dev/tools/stakeframe/node-v24.20.0-win-x64:/c/Users/Rhian Batista/dev/tools/stakeframe/pnpm:$PATH"
   ```
   (PowerShell equivalente: `$env:Path = "C:\Users\Rhian Batista\dev\tools\stakeframe\node-v24.20.0-win-x64;C:\Users\Rhian Batista\dev\tools\stakeframe\pnpm;$env:Path"`.)
5. Confirmar `node --version` → `v24.20.0` e `pnpm --version` → `11.24.0`
   antes de rodar qualquer comando do projeto.

Não instalar Node/pnpm globalmente nem alterar o runtime interno do Hermes ou
de outros projetos.

## Setup

```bash
pnpm install --frozen-lockfile
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
