import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { fromNodeHeaders } from 'better-auth/node';
import { OnboardingError, type OnboardingService, type OnboardingStatus } from '@stakeframe/db';
import { apiErrorSchema, onboardingStatusSchema, onboardingUpdateSchema } from '@stakeframe/shared';
import type { OwnerAuth } from './auth.js';
import { ownerSessionSecurity } from './openapi.js';
import { sendApiError } from './api-errors.js';

/**
 * Onboarding routes (STK-F1-09).
 *
 * Gate is the same as every private product route: valid session of an admitted identity
 * (`ownerAuth.getOwner`) plus an effective consent state — a pending or outdated acceptance
 * answers `403 CONSENT_REQUIRED` before any organization data is exposed, and no rule here can
 * be bypassed from the browser (the status is computed on the server).
 */
export function registerOnboardingRoutes(
  app: FastifyInstance,
  ownerAuth: OwnerAuth | undefined,
  service: OnboardingService | undefined,
) {
  const identities = new WeakMap<FastifyRequest, string>();
  /** The service returns `Date`s; the shared contract (and OpenAPI) uses ISO strings. */
  function serialize(status: OnboardingStatus) {
    return {
      displayName: status.displayName,
      timezone: status.timezone,
      steps: {
        profile: {
          completed: status.steps.profile.completed,
          completedAt: status.steps.profile.completedAt?.toISOString() ?? null,
        },
        bankroll: status.steps.bankroll,
        firstBet: status.steps.firstBet,
      },
      completedAt: status.completedAt?.toISOString() ?? null,
    };
  }
  const errors = {
    400: apiErrorSchema,
    401: apiErrorSchema,
    403: apiErrorSchema,
    409: apiErrorSchema,
    500: apiErrorSchema,
    503: apiErrorSchema,
    default: apiErrorSchema,
  };
  const authorize = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!ownerAuth) return sendApiError(request, reply, 503, 'AUTH_NOT_CONFIGURED');
    if (
      request.method !== 'GET' &&
      (request.headers.origin !== ownerAuth.origin ||
        request.headers['sec-fetch-site'] === 'cross-site')
    )
      return sendApiError(request, reply, 403, 'ORIGIN_NOT_ALLOWED');
    const headers = fromNodeHeaders({ cookie: request.headers.cookie });
    const owner = await ownerAuth.getOwner(headers);
    if (!owner) return sendApiError(request, reply, 401, 'UNAUTHENTICATED');
    if (owner.status === 'consent_required')
      return sendApiError(request, reply, 403, 'CONSENT_REQUIRED');
    if (!service) return sendApiError(request, reply, 503, 'AUTH_UNAVAILABLE');
    identities.set(request, owner.user.id);
  };
  app.get(
    '/api/v1/onboarding',
    {
      onRequest: authorize,
      schema: {
        operationId: 'getOnboarding',
        tags: ['Onboarding'],
        summary: 'Consultar o progresso dos primeiros passos',
        security: ownerSessionSecurity,
        description:
          'Estado do onboarding do próprio usuário autenticado: nome exibido, fuso horário e os três passos (perfil, banca inicial e primeira aposta). O passo da banca reflete o núcleo financeiro e o da primeira aposta reflete apostas registradas — o servidor é a fonte da verdade; nada é gravado por esta consulta. Exige sessão válida e consentimento vigente.',
        response: { 200: onboardingStatusSchema, ...errors },
      },
    },
    async (request, reply) => {
      if (service === undefined) return;
      const status = await service.statusFor(identities.get(request)!);
      return reply.send(onboardingStatusSchema.parse(serialize(status)));
    },
  );
  app.post(
    '/api/v1/onboarding',
    {
      onRequest: authorize,
      schema: {
        operationId: 'updateOnboarding',
        tags: ['Onboarding'],
        summary: 'Atualizar o progresso dos primeiros passos',
        security: ownerSessionSecurity,
        description:
          'Atualizações idempotentes do próprio usuário: `profile` grava o nome exibido e um fuso horário IANA válido; `finish` conclui explicitamente os primeiros passos e exige, no servidor, perfil concluído, banca inicial configurada para a organização e a decisão explícita da primeira aposta (`registered`, verificado contra apostas registradas, ou `deferred`, a escolha de continuar sem aposta). O fuso é validado no servidor, o nome exibido atualiza a identidade do usuário e repetir a operação não duplica estado. Exige Origin da aplicação, sessão válida e consentimento vigente; pré-requisitos não satisfeitos respondem `409 ONBOARDING_PREREQUISITE`.',
        body: onboardingUpdateSchema,
        response: { 200: onboardingStatusSchema, ...errors },
      },
    },
    async (request, reply) => {
      if (service === undefined) return;
      const update = onboardingUpdateSchema.parse(request.body);
      const userId = identities.get(request)!;
      try {
        const status =
          update.step === 'profile'
            ? await service.updateProfile(userId, {
                displayName: update.displayName,
                timezone: update.timezone,
              })
            : await service.finish(userId, update.firstBet);
        return reply.send(onboardingStatusSchema.parse(serialize(status)));
      } catch (error) {
        if (error instanceof OnboardingError) return sendApiError(request, reply, 409, error.code);
        throw error;
      }
    },
  );
}
