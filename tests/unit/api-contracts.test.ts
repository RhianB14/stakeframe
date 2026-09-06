import { afterEach, describe, expect, it, vi } from 'vitest';
import SwaggerParser from '@apidevtools/swagger-parser';
import type { OpenAPIV3 } from 'openapi-types';
import { apiErrorSchema, ownerSessionSchema } from '../../packages/shared/src/index.js';
import { createApp } from '../../apps/api/src/app.js';

const apps: ReturnType<typeof createApp>[] = [];
function createContractApp() {
  const checkDatabase = vi.fn(async () => {
    throw new Error('DATABASE_MUST_NOT_BE_USED');
  });
  const app = createApp({ checkDatabase });
  apps.push(app);
  return { app, checkDatabase };
}
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('executable API contracts', () => {
  it('exports a valid document covering every public route without accessing the database', async () => {
    const { app, checkDatabase } = createContractApp();
    const routes: string[] = [];
    app.addHook('onRoute', (route) => {
      for (const method of [route.method].flat()) {
        if (method !== 'HEAD' && !route.schema?.hide)
          routes.push(`${method.toLowerCase()} ${route.url}`);
      }
    });
    const response = await app.inject('/api/openapi.json');
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    const document = app.swagger() as OpenAPIV3.Document;
    expect(response.json()).toEqual(document);
    await SwaggerParser.validate(structuredClone(document), {
      resolve: { external: false, file: false, http: false },
    });
    const operations = Object.entries(document.paths).flatMap(([path, methods]) =>
      (['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const).flatMap(
        (method) => {
          const operation = methods?.[method];
          if (!operation) return [];
          expect(operation.operationId).toEqual(expect.any(String));
          expect(operation.responses).toBeDefined();
          return `${method} ${path}`;
        },
      ),
    );
    expect(operations.sort()).toEqual(routes.sort());
    expect(operations).toHaveLength(7);
    expect(document.servers).toEqual([{ url: '/', description: 'Mesma origem da aplicação' }]);
    expect(checkDatabase).not.toHaveBeenCalled();
    expect(response.body).not.toMatch(
      /client_secret|ownerEmail|DATABASE_URL|localhost:|127\.0\.0\.1:/,
    );
    const redirect = document.paths['/api/auth/callback/google']?.get?.responses['302'];
    expect(redirect).toBeDefined();
    expect(redirect).not.toHaveProperty('content');
    expect(document.paths['/api/auth/sign-in/google']?.post?.requestBody).toHaveProperty(
      'required',
      false,
    );
    expect(document.paths['/api/auth/sign-out']?.post?.requestBody).toHaveProperty(
      'required',
      false,
    );
    expect(document.paths['/api/v1/me']?.get?.security).toEqual([
      { localOwnerSession: [] },
      { secureOwnerSession: [] },
    ]);
  });

  it.each([
    { method: 'POST' as const, url: '/api/auth/sign-in/google', payload: ['private-input'] },
    {
      method: 'POST' as const,
      url: '/api/auth/sign-out',
      headers: { 'content-type': 'application/json' },
      payload: '42',
    },
    {
      method: 'GET' as const,
      url: '/api/auth/callback/google?state=private-input&state=duplicate',
    },
    { method: 'GET' as const, url: `/api/auth/callback/google?code=${'x'.repeat(8193)}` },
  ])('refuses invalid request %# before calling authentication', async (request) => {
    const { app } = createContractApp();
    const response = await app.inject(request);
    expect(response.statusCode).toBe(400);
    expect(apiErrorSchema.parse(response.json()).error.code).toBe('INVALID_REQUEST');
    expect(response.body).not.toMatch(/private-input|duplicate|validation|stack/);
  });

  it.each([false, true])(
    'enforces response shape and removes private fields (invalid=%s)',
    async (invalid) => {
      const { app } = createContractApp();
      app.after(() => {
        app.get(
          '/contract-fixture',
          {
            schema: { hide: true, response: { 200: ownerSessionSchema, 500: apiErrorSchema } },
          },
          async () => ({
            user: {
              id: 'fixture-owner',
              name: 'Fixture Owner',
              email: 'private-input@example.test',
            },
            expiresAt: invalid ? 'private-invalid-date' : '2026-09-07T00:00:00.000Z',
            token: 'private-input-token',
          }),
        );
      });
      const response = await app.inject('/contract-fixture');
      expect(response.statusCode).toBe(invalid ? 500 : 200);
      if (invalid) expect(apiErrorSchema.parse(response.json()).error.code).toBe('INTERNAL_ERROR');
      else
        expect(response.json()).toEqual({
          user: { id: 'fixture-owner', name: 'Fixture Owner' },
          expiresAt: '2026-09-07T00:00:00.000Z',
        });
      expect(response.body).not.toMatch(/private-input|private-invalid-date|email|token|stack/);
    },
  );
});
