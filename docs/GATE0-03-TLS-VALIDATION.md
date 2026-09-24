# GATE0-03 — Ensaio TLS de renovação/reemissão (Pebble) e mapeamento do Gate 0 item 3

Registro da STK-A3 fase 2B (itens D4/D5 do plano aprovado). O ensaio roda
exclusivamente sobre recursos descartáveis do repositório
(`compose.production.yml` + `compose.rehearsal.yml` + runner
`scripts/deployment-rehearsal.mjs`); nenhum artefato, serviço ou certificado de
produção é tocado.

## 1. Mapeamento do Gate 0 item 3

O Gate 0 exige: "Ensaiar renovação/reemissão TLS em isolamento e comprovar
alerta de expiração em produção."

- **PROVA A (este documento)** — renovação/reemissão em isolamento, com o
  servidor ACME de teste Pebble, sem sair da máquina/CI.
- **PROVA B (janela W3)** — alerta de expiração disparando em produção; será
  executada com o check `tls` já presente na `main` desde a fase 2A
  (`TLS_EXPIRY_WARN_DAYS=21` / `TLS_EXPIRY_FAIL_DAYS=7`), via limiar temporário
  e sem tocar no certificado real.

## 2. Desenho do ensaio

### 2.1 Servidor ACME de teste (Pebble)

- Imagem pinada por digest:
  `ghcr.io/letsencrypt/pebble:2.10.1@sha256:ddf230642b1a584f519f32e347de1b05a6e4c1f6c35c1863b33effeab5f78199`
  — índice multi-arquitetura com `linux/amd64` e `linux/arm64` (a CI roda nos
  dois runners).
- Executa como `1000:1000`, `read_only: true`, `cap_drop: [ALL]`,
  `tmpfs: /tmp`, sem portas publicadas, na rede interna `rehearsal-acme` (o
  serviço `web` recebe nela o alias `stakeframe.example.test` para a resolução
  dos desafios ACME).
- `infra/production/pebble-config.json` (montada read-only) define os desafios
  `httpPort: 8080` / `tlsPort: 8443` — as portas internas do Caddy no ensaio —
  e o perfil `default` com `validityPeriod: 3600`. A validade de uma hora é o
  que permite exercitar `renewal_window_ratio 0.98` em minutos: 2% de 1h = 72s
  de vida decorrida antes da primeira janela de renovação.
- O Pebble regenera a CA emissora a cada start. Por isso o ensaio lê
  `roots/0` e `intermediates/0` da API de gerência (HTTPS verificado contra a
  raiz estática `pebble.minica.pem`, copiada da própria imagem pelo runner)
  antes de aceitar qualquer certificado servido.

### 2.2 Injeção do override ACME (`global.d`)

- `infra/Caddyfile.production` ganha `import /etc/caddy/global.d/*` no bloco
  global. Em produção o diretório não existe e o glob expande para nada —
  comportamento verificado com `caddy validate` em três cenários: diretório
  **ausente**, diretório **vazio** e com o arquivo de override.
- O ensaio monta `infra/production/tls.rehearsal-acme.conf` em
  `/etc/caddy/global.d/`, com `acme_ca https://pebble:14000/dir`,
  `acme_ca_root /etc/caddy/pebble/pebble.minica.pem`, `renew_interval 1m` e
  `renewal_window_ratio 0.98`.
- O `tls.conf` de produção permanece o mesmo (`tls {$ACME_EMAIL}`); o emissor
  padrão passa a ser o Pebble apenas no ensaio, por causa do override.

### 2.3 Sequência verificada pelo runner

1. **Emissão** — após o startup, o ensaio espera o primeiro certificado e
   registra serial, `NotBefore`/`NotAfter` e handshake verificado contra as
   raízes do Pebble.
2. **Renovação in-place** — aguarda a troca de serial (janela `0.98` +
   `renew_interval 1m`) contabilizando handshakes contínuos; qualquer handshake
   com erro falha o ensaio (sem perda de serviço).
3. **Reemissão** — o `web` é removido, o volume `caddy-data` do projeto
   efêmero é destruído e o `web` sobe de novo: nova ordem ACME e serial
   inédito.
4. **Persistência pós-restart** — depois do `restart`, o certificado servido
   precisa pertencer ao acervo persistido em `caddy-data` (checagem por serial
   contra os arquivos em `/data/caddy/certificates/**`).

## 3. Resultados do ensaio local

Execução de 2026-09-24 em Windows 11 + Docker Desktop (Docker 29.7.2),
`pnpm deployment:rehearse`, projeto `stk-deploy-9d0152d6c46f4ee9813dc067b9cf9933`
— status **`passed`** (`REHEARSAL_EXIT=0`).

| Evento    | Serial             | NotBefore                | NotAfter                 | Observações                       |
| --------- | ------------------ | ------------------------ | ------------------------ | --------------------------------- |
| emissão   | `15D3C7631C04F47A` | Sep 24 22:06:26 2026 GMT | Sep 24 23:06:25 2026 GMT | handshakes=1                      |
| renovação | `2996A226774DE25F` | Sep 24 22:08:25 2026 GMT | Sep 24 23:08:24 2026 GMT | 24 handshakes, 0 falhas; 115s     |
| reemissão | `0F2EDBBBFB6015CF` | Sep 24 22:08:36 2026 GMT | Sep 24 23:08:35 2026 GMT | 234ms após `caddy-data` destruído |

Log sanitizado (CA de teste, domínio fictício):

```
DEPLOYMENT_REHEARSAL_TLS_EVENT phase=issued serial=15D3C7631C04F47A notBefore=Sep 24 22:06:26 2026 GMT notAfter=Sep 24 23:06:25 2026 GMT handshakes=1
DEPLOYMENT_REHEARSAL_TLS_EVENT phase=renewed previousSerial=15D3C7631C04F47A serial=2996A226774DE25F notBefore=Sep 24 22:08:25 2026 GMT notAfter=Sep 24 23:08:24 2026 GMT handshakes=24 elapsedMs=115334
DEPLOYMENT_REHEARSAL_TLS_EVENT phase=reissued previousSerial=2996A226774DE25F serial=0F2EDBBBFB6015CF notBefore=Sep 24 22:08:36 2026 GMT notAfter=Sep 24 23:08:35 2026 GMT elapsedMs=234
```

Checagens registradas no relatório do run: configurações de compose/restore,
migração explícita e repetível, `pinned-acme-test-server-and-static-trust-anchor`,
serviços privados saudáveis, papel de banco não-superusuário, TLS confiável com
negações de auth, `in-place-acme-renewal-serial-rotation`,
`acme-reissuance-after-caddy-data-reset`,
`database-and-certificate-persistence-after-restart` e limpeza integral dos
recursos do projeto (containers, volumes e redes) ao final.

## 4. Execução na CI

O mesmo ensaio roda nos jobs `application-check` (x86_64) e
`application-arm64-check` (arm64), que executam `pnpm deployment:rehearse`
integralmente. Os identificadores do run do PR, os nomes dos jobs verdes e os
trechos de eventos (seriais) de cada arquitetura são anexados no corpo da PR e
na devolutiva da fase; este documento recebe a atualização correspondente após
a primeira execução verde.

## 5. Limites

- Não exercita o ACME público (Let's Encrypt), CAA ou DNS real: isso continua
  coberto pelo fluxo de produção do Caddy e será observado na janela W3
  (PROVA B, item D7). O ensaio prova renovação/reemissão, troca de serial sem
  perda de serviço e persistência do acervo — não a cadeia pública.
- O alerta de expiração (check `tls`) não é exercitado aqui; é objeto da
  PROVA B, com o check já na `main` desde a fase 2A.
- Nenhuma porta além das efêmeras locais do `web` é publicada; o Pebble fica
  restrito à rede interna do ensaio.
- As imagens de produção permanecem intocadas: o `import /etc/caddy/global.d/*`
  é no-op em produção (validado nos três cenários de diretório) e o `web` de
  produção segue emitindo via ACME público.

## 6. Reprodução

`pnpm deployment:rehearse` (requer Docker local; cria, usa e destrói o projeto
`stk-deploy-*` inteiro, inclusive os volumes). Em Windows com shell MSYS
(git-bash), execute pelo cmd/PowerShell: o `whoami.exe` do MSYS (usr/bin)
sombreia o do System32 e a etapa de ACL local aborta em `initialize`.

## 7. Referências

- `compose.rehearsal.yml` — overlay do ensaio (Pebble + override + alias).
- `infra/production/pebble-config.json` — perfil/portas do Pebble.
- `infra/production/tls.rehearsal-acme.conf` — override de `global.d`.
- `infra/Caddyfile.production` — bloco global com o import condicional.
- `scripts/deployment-rehearsal.mjs` — estágios `pebble`, `tls`,
  `tls-renewal` e `tls-reissuance`.
- `scripts/deployment/config.mjs` — validação reforçada do overlay.
