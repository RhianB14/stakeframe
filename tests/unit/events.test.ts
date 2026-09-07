import { describe, expect, it, vi } from 'vitest';
import {
  lookupEvent,
  parseSportsEvents,
  parseTavilyEvents,
} from '../../apps/worker/src/event-providers.js';
import { readEventSearchConfig } from '../../packages/db/src/events.js';
import { localInstant } from '../../apps/web/src/product/api.js';

describe('event provider boundaries', () => {
  it('keeps sources opt-in and rejects ambiguous flags', () => {
    expect(readEventSearchConfig({})).toEqual({ thesportsdb: false, tavily: false });
    expect(() => readEventSearchConfig({ TAVILY_ENABLED: '1' })).toThrow(
      'INVALID_EVENT_SEARCH_CONFIGURATION',
    );
  });
  it('preserves offsetless source times without inventing UTC and identifies postponement', () => {
    const rows = parseSportsEvents({
      event: [
        {
          idEvent: '123',
          strEvent: 'Aurora vs Central',
          dateEvent: '2026-09-01',
          strTimestamp: '2026-09-01T00:30:00',
          strPostponed: 'yes',
        },
        {
          idEvent: '124',
          strEvent: 'Aurora vs Central',
          dateEvent: '2026-09-01',
          strTimestamp: '2026-09-01T00:30:00Z',
        },
      ],
    });
    expect(rows[0]).toMatchObject({
      rawDate: '2026-09-01',
      rawTime: '2026-09-01T00:30:00',
      suggestedAt: null,
      postponed: true,
    });
    expect(rows[1]?.suggestedAt).toBe('2026-09-01T00:30:00Z');
    expect(parseSportsEvents({ event: null })).toEqual([]);
    expect(() => parseSportsEvents({ error: 'private-source-error' })).toThrow(
      'EVENT_INVALID_RESPONSE',
    );
  });
  it('does not convert publication dates or text snippets into event dates and refuses unsafe links', () => {
    const rows = parseTavilyEvents({
      results: [
        {
          title: 'Agenda',
          url: 'https://example.test/agenda',
          content: 'Publicado em 01/09/2026. Aurora x Central em outro dia.',
          published_date: '2026-09-01',
        },
        { title: 'Unsafe', url: 'javascript:alert(1)', content: 'x' },
        { title: 'Unsafe', url: 'https://name:password@example.test/', content: 'x' },
      ],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ rawDate: null, rawTime: null, suggestedAt: null });
  });
  it('uses a fixed structured endpoint with optional date and caps result count', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        event: Array.from({ length: 12 }, (_, i) => ({
          idEvent: String(i + 1),
          strEvent: 'Aurora vs Central',
        })),
      }),
    );
    const result = await lookupEvent({
      search: { provider: 'thesportsdb', query: 'Aurora × Central', dateHint: '2026-09-01' },
      fetchImpl,
    });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe(
      'https://www.thesportsdb.com/api/v1/json/123/searchevents.php?e=Aurora_vs_Central&d=2026-09-01',
    );
    expect(init?.redirect).toBe('error');
    expect(result).toHaveLength(5);
  });
  it('fixes Tavily to basic search without automatic parameters or generated answers', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ results: [] }));
    await lookupEvent({
      search: { provider: 'tavily', query: 'Aurora x Central', dateHint: null },
      tavilyKey: 'synthetic-key',
      fetchImpl,
    });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe('https://api.tavily.com/search');
    expect(JSON.parse(String(init?.body))).toMatchObject({
      search_depth: 'basic',
      auto_parameters: false,
      max_results: 5,
      include_answer: false,
      include_raw_content: false,
    });
  });
  it.each([429, 503])(
    'never retries HTTP %i and omits private provider responses from errors',
    async (status) => {
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response('private-provider-details', { status }));
      await expect(
        lookupEvent({
          search: { provider: 'thesportsdb', query: 'Aurora x Central', dateHint: null },
          fetchImpl,
        }),
      ).rejects.toThrow(/^EVENT_/);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    },
  );
  it('converts São Paulo across a UTC date boundary and rejects missing/ambiguous historical DST hours', () => {
    expect(localInstant('2026-08-31T21:30')).toBe('2026-09-01T00:30:00.000Z');
    expect(() => localInstant('2018-11-04T00:30')).toThrow();
    expect(() => localInstant('2019-02-16T23:30')).toThrow();
    expect(localInstant('2018-11-04T01:30')).toBe('2018-11-04T03:30:00.000Z');
  });
});
