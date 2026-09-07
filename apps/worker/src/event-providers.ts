import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import {
  createEventService,
  readEventSearchConfig,
  readSecret,
  type Database,
} from '@stakeframe/db';
import { eventCandidateSchema, type EventCandidate, type EventSearch } from '@stakeframe/shared';
import { IntegrationError, readJson } from './http.js';

function text(value: unknown, limit: number) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, limit) : null;
}
function safeUrl(value: unknown) {
  if (typeof value !== 'string' || value.length > 2000) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}
export function parseSportsEvents(value: unknown): EventCandidate[] {
  const parsed = z
    .object({
      event: z.array(z.record(z.string(), z.unknown())).nullable().optional(),
      events: z.array(z.record(z.string(), z.unknown())).nullable().optional(),
    })
    .safeParse(value);
  if (!parsed.success || (!('event' in parsed.data) && !('events' in parsed.data)))
    throw new IntegrationError('EVENT_INVALID_RESPONSE');
  const result: EventCandidate[] = [];
  for (const event of (parsed.data.event ?? parsed.data.events ?? []).slice(0, 5)) {
    const id = text(event.idEvent, 30);
    const title = text(event.strEvent, 300);
    if (!id || !/^\d+$/.test(id) || !title) continue;
    const timestamp = text(event.strTimestamp, 100);
    const explicit = z.iso.datetime({ offset: true }).safeParse(timestamp);
    result.push(
      eventCandidateSchema.parse({
        id: randomUUID(),
        provider: 'thesportsdb',
        title,
        url: `https://www.thesportsdb.com/event/${id}`,
        excerpt: [text(event.strLeague, 200), text(event.strSport, 100), text(event.strStatus, 100)]
          .filter(Boolean)
          .join(' · '),
        rawDate: text(event.dateEvent, 100),
        rawTime: timestamp ?? text(event.strTime, 100),
        // The public API commonly returns offsetless timestamps. Do not assume UTC.
        suggestedAt: explicit.success ? explicit.data : null,
        postponed:
          String(event.strPostponed).toLowerCase() === 'yes' ||
          /postpon/i.test(String(event.strStatus)),
      }),
    );
  }
  return result;
}
export function parseTavilyEvents(value: unknown): EventCandidate[] {
  const parsed = z
    .object({
      results: z.array(z.object({ title: z.string(), url: z.string(), content: z.string() })),
    })
    .safeParse(value);
  if (!parsed.success) throw new IntegrationError('EVENT_INVALID_RESPONSE');
  const result: EventCandidate[] = [];
  for (const item of parsed.data.results.slice(0, 5)) {
    const url = safeUrl(item.url);
    if (!url) continue;
    result.push(
      eventCandidateSchema.parse({
        id: randomUUID(),
        provider: 'tavily',
        title: item.title.slice(0, 300),
        url,
        excerpt: item.content.slice(0, 3000),
        // Publication dates and dates mentioned in snippets are not event instants.
        rawDate: null,
        rawTime: null,
        suggestedAt: null,
        postponed: false,
      }),
    );
  }
  return result;
}
export async function lookupEvent(options: {
  search: Pick<EventSearch, 'provider' | 'query' | 'dateHint'>;
  tavilyKey?: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}) {
  const { search } = options;
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(15_000)])
    : AbortSignal.timeout(15_000);
  let url: URL;
  const init: RequestInit = { redirect: 'error', signal };
  if (search.provider === 'thesportsdb') {
    url = new URL('https://www.thesportsdb.com/api/v1/json/123/searchevents.php');
    url.searchParams.set(
      'e',
      search.query.replace(/\s*[×]\s*|\s+(?:x|vs\.?|versus)\s+/gi, '_vs_').replaceAll(' ', '_'),
    );
    if (search.dateHint) url.searchParams.set('d', search.dateHint);
  } else {
    if (!options.tavilyKey) throw new IntegrationError('EVENT_PROVIDER_UNAVAILABLE');
    url = new URL('https://api.tavily.com/search');
    init.method = 'POST';
    init.headers = {
      authorization: `Bearer ${options.tavilyKey}`,
      'content-type': 'application/json',
    };
    init.body = JSON.stringify({
      query: [search.query, search.dateHint, 'horário partida'].filter(Boolean).join(' '),
      search_depth: 'basic',
      auto_parameters: false,
      max_results: 5,
      include_answer: false,
      include_raw_content: false,
      include_images: false,
      topic: 'general',
    });
  }
  try {
    const response = await (options.fetchImpl ?? fetch)(url, init);
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new IntegrationError(
        response.status === 429 ? 'EVENT_RATE_LIMITED' : 'EVENT_PROVIDER_UNAVAILABLE',
      );
    }
    const value = await readJson(response, 262_144);
    return search.provider === 'thesportsdb' ? parseSportsEvents(value) : parseTavilyEvents(value);
  } catch (error) {
    if (error instanceof IntegrationError && error.code.startsWith('EVENT_')) throw error;
    throw new IntegrationError('EVENT_CONNECTION_FAILED');
  }
}
export function startEventSearch(database: Database, env: NodeJS.ProcessEnv) {
  const config = readEventSearchConfig(env);
  const tavilyKey = config.tavily ? readSecret(env, 'TAVILY_API_KEY') : undefined;
  if (config.tavily && (!tavilyKey || !/^[A-Za-z0-9_-]{20,200}$/.test(tavilyKey)))
    throw new Error('INVALID_EVENT_SEARCH_CONFIGURATION');
  const service = createEventService(database, config);
  const controller = new AbortController();
  const task = (async () => {
    while (!controller.signal.aborted) {
      let id: string | undefined;
      try {
        const search = await service.claim();
        if (search) {
          id = search.id;
          const candidates = await lookupEvent({
            search,
            ...(tavilyKey ? { tavilyKey } : {}),
            signal: controller.signal,
          });
          await service.complete(id, candidates);
          continue;
        }
      } catch (error) {
        if (id)
          await service
            .fail(id, error instanceof IntegrationError ? error.code : 'EVENT_CONNECTION_FAILED')
            .catch(() => undefined);
        console.warn('EVENT_SEARCH_FAILED');
      }
      await delay(5000, undefined, { signal: controller.signal }).catch(() => undefined);
    }
  })();
  return {
    check() {
      if (controller.signal.aborted) throw new Error('EVENT_SEARCH_STOPPED');
    },
    async stop() {
      controller.abort();
      await task;
    },
  };
}
