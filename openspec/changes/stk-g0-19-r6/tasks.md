## 1. Correções

- [x] 1.1 GET do detalhe com sessão OU initData validado; hardening (duplicados, futuro, id positivo)
- [x] 1.2 Botões funcionais: web_app com URL validada + callbacks com confirmação e idempotência
- [x] 1.3 Retorno visual sem gate (candidato, OCR, decisão, prompt, corpus/docs)
- [x] 1.4 Freebet: filtro na listagem + validação completa sob lock + concorrência no financeiro

## 2. Testes

- [x] 2.1 Rota real com initData assinado (7 casos) + unit de hardening/botões/callbacks
- [x] 2.2 Callbacks (status/casa/exclusão/confirmação/idempotência/isolamento) moçados
- [x] 2.3 Freebet (casa/valor/expirado/usado/outra org/política/dois créditos/concorrência)
- [x] 2.4 RED→GREEN por mutação dos quatro bloqueios
- [ ] 2.5 Bateria completa + reavaliação offline + commit/push + CI + devolutiva
