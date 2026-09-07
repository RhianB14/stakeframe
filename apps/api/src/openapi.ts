import swagger from '@fastify/swagger';
import type { FastifyInstance } from 'fastify';
import type { OpenAPIV3 } from 'openapi-types';
import { z } from 'zod';
import {
  jsonSchemaTransform,
  jsonSchemaTransformObject,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';

export const ownerSessionSecurity = [{ localOwnerSession: [] }, { secureOwnerSession: [] }];

export function registerApiContracts(app: FastifyInstance) {
  const optionalBodies = new Set<string>();
  app.addHook('onRoute', ({ schema }) => {
    if (
      schema?.operationId &&
      schema.body instanceof z.ZodType &&
      schema.body.safeParse(null).success &&
      schema.body.safeParse(undefined).success
    ) {
      optionalBodies.add(schema.operationId);
    }
  });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.register(swagger, {
    openapi: {
      openapi: '3.0.3',
      info: {
        title: 'Stakeframe API',
        version: '0.0.0',
        description:
          'Aplicação pessoal com login Google exclusivo do proprietário. Operações financeiras exigem sessão, origem, chave de idempotência e versão. Decimais são strings; erros usam código estável e requestId gerado pelo servidor.',
      },
      servers: [{ url: '/', description: 'Mesma origem da aplicação' }],
      tags: [
        { name: 'Financeiro', description: 'Banca, cadastros e histórico auditável.' },
        { name: 'Apostas', description: 'Apostas manuais e liquidações.' },
        { name: 'Análises', description: 'Resultados por evento e exportações privadas.' },
        {
          name: 'Importações',
          description: 'Comprovantes privados, extração e revisão antes do lançamento financeiro.',
        },
        {
          name: 'Operação',
          description: 'Verificações públicas e monitor operacional com credencial própria.',
        },
        {
          name: 'Autenticação',
          description:
            'Fluxo de navegador Google e sessão própria. Tokens Google não autenticam chamadas da API.',
        },
      ],
      components: {
        securitySchemes: {
          operationsMonitor: {
            type: 'http',
            scheme: 'bearer',
            description:
              'Segredo dedicado somente à leitura de sinais operacionais. Não acessa apostas ou comandos.',
          },
          localOwnerSession: {
            type: 'apiKey',
            in: 'cookie',
            name: 'stakeframe.session_token',
            description:
              'Cookie HttpOnly de sessão, usado somente no HTTP de loopback. Não inserir tokens Google aqui.',
          },
          secureOwnerSession: {
            type: 'apiKey',
            in: 'cookie',
            name: '__Secure-stakeframe.session_token',
            description: 'Variante Secure para HTTPS; infraestrutura HTTPS ainda não publicada.',
          },
        },
      },
    },
    transform: jsonSchemaTransform,
    transformObject: (input) => {
      const document = jsonSchemaTransformObject(input) as OpenAPIV3.Document;
      for (const kind of ['csv', 'json']) {
        const operation = document.paths[`/api/v1/exports/${kind}`]?.get;
        if (operation)
          operation.responses['200'] = {
            description: 'Arquivo privado completo; exportação interrompida em caso de falha.',
            content: {
              [kind === 'csv' ? 'text/csv' : 'application/json']: {
                schema: { type: 'string', format: 'binary' },
              },
            },
          };
      }
      const image = document.paths['/api/v1/imports/{id}/image']?.get;
      if (image)
        image.responses['200'] = {
          description: 'Bytes privados; sessão exigida em cada leitura.',
          content: {
            'image/png': { schema: { type: 'string', format: 'binary' } },
            'image/jpeg': { schema: { type: 'string', format: 'binary' } },
          },
        };
      // Swagger assumes Fastify always requires schema.body. Our Zod compiler also
      // accepts absent bodies (Fastify passes null), so derive this from the route schema.
      for (const path of Object.values(document.paths)) {
        for (const method of ['post', 'put', 'patch', 'delete'] as const) {
          const operation = path?.[method];
          const body = operation?.requestBody;
          if (
            operation?.operationId &&
            optionalBodies.has(operation.operationId) &&
            body &&
            !('$ref' in body)
          )
            body.required = false;
        }
      }
      return document;
    },
  });
}
