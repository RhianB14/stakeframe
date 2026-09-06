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
          'Base local do M0. Login Google exclusivo do proprietário; nenhuma operação financeira disponível. Erros JSON usam código estável e requestId gerado pelo servidor. Readiness indisponível usa o contrato técnico de healthcheck.',
      },
      servers: [{ url: '/', description: 'Mesma origem da aplicação' }],
      tags: [
        { name: 'Operação', description: 'Verificações técnicas públicas, sem dados privados.' },
        {
          name: 'Autenticação',
          description:
            'Fluxo de navegador Google e sessão própria. Tokens Google não autenticam chamadas da API.',
        },
      ],
      components: {
        securitySchemes: {
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
