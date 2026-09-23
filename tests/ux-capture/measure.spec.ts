// Medição do alvo efetivo do filtro segmentado (.mini-segmented label)
// para a correção de fundamentação STK-UX-01/02-R1.
//
// O Codex pediu: meça largura, altura e elemento ACIONÁVEL antes de
// afirmar não conformidade. O input dentro do label é
// `opacity: 0; pointer-events: none`, logo o alvo acionável é o <label>.
//
// Roda APENAS com o config próprio (tests/ux-capture/playwright.ux.config.ts).
// Uso: E2E_BASE_URL=http://127.0.0.1:8099 PLAYWRIGHT_CHANNEL=msedge \
//   npx playwright test --config tests/ux-capture/playwright.ux.config.ts \
//   tests/ux-capture/measure.spec.ts --reporter=list
import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ImportDetail } from '../../packages/shared/src/index.js';
import {
  betId,
  house,
  house2,
  house3,
  importId,
  miniAppImport,
  richBets,
  richReport,
  richWorkspace,
} from './fixtures.js';

const imageFile = fileURLToPath(new URL('../fixtures/ai/synthetic-ticket.png', import.meta.url));

// Mesmas rotas de boot do capture.spec.ts (copiadas para não duplicar os testes).
async function boot(page: Page) {
  await page.route('**/api/v1/system/status', (route) =>
    route.fulfill({
      json: {
        name: 'Stakeframe',
        stage: 'local-setup',
        database: 'available',
        authentication: 'google',
        productEnabled: true,
        release: {
          version: '0.1.0-beta.7',
          commit: 'b'.repeat(40),
          builtAt: '2026-09-23T12:00:00Z',
          environment: 'production',
        },
      },
    }),
  );
  await page.route('**/api/v1/onboarding', (route) =>
    route.fulfill({
      json: {
        displayName: 'Usuário Sintético',
        timezone: 'America/Sao_Paulo',
        steps: {
          profile: { completed: true, completedAt: '2026-09-14T12:00:00.000Z' },
          bankroll: { completed: true },
          firstBet: { completed: true, resolution: 'registered' },
        },
        completedAt: '2026-09-14T12:30:00.000Z',
      },
    }),
  );
  await page.route('**/api/v1/me', (route) =>
    route.fulfill({
      json: {
        user: { id: 'fixture-owner', name: 'Usuário Sintético' },
        organization: {
          id: '00000000-0000-4000-8000-000000000001',
          role: 'owner',
        },
        expiresAt: '2099-09-01T00:00:00Z',
      },
    }),
  );
  await page.route('**/api/v1/workspace', (route) => route.fulfill({ json: richWorkspace() }));
  await page.route('**/api/v1/reports?*', (route) => route.fulfill({ json: richReport() }));
  await page.route('**/api/v1/reports/options', (route) =>
    route.fulfill({
      json: {
        sports: ['Futebol', 'Basquete', 'Tênis'],
        bookmakers: [house, house2, house3],
      },
    }),
  );
  await page.route('**/api/v1/reports/bets?*', (route) =>
    route.fulfill({
      json: {
        items: richBets(),
        total: richBets().length,
        page: 1,
        pageSize: 25,
      },
    }),
  );
  await page.route('**/api/v1/bets?*', (route) =>
    route.fulfill({
      json: {
        items: richBets(),
        total: richBets().length,
        page: 1,
        pageSize: 25,
      },
    }),
  );
  await page.route(`**/api/v1/bets/${betId}`, (route) =>
    route.fulfill({ json: { bet: richBets()[0], settlements: [] } }),
  );
  await page.route('**/api/v1/journal?*', (route) =>
    route.fulfill({ json: { items: [], total: 0, page: 1, pageSize: 25 } }),
  );
  await page.route('**/api/v1/calendar?*', (route) =>
    route.fulfill({ json: { items: [], total: 0, page: 1, pageSize: 25 } }),
  );
}

async function importRoutes(page: Page, detail: ImportDetail = miniAppImport()) {
  await page.route('**/api/v1/imports?*', (route) =>
    route.fulfill({
      json: { items: [detail.item], total: 1, page: 1, pageSize: 25 },
    }),
  );
  await page.route(`**/api/v1/imports/${importId}`, (route) => route.fulfill({ json: detail }));
  await page.route(`**/api/v1/imports/${importId}/image`, (route) =>
    route.fulfill({ contentType: 'image/png', body: readFileSync(imageFile) }),
  );
}

async function telegram(page: Page) {
  await page.addInitScript(() => {
    (window as unknown as { Telegram: unknown }).Telegram = {
      WebApp: {
        initData: 'stub-initdata',
        close: () => undefined,
        HapticFeedback: { notificationOccurred: () => undefined },
      },
    };
  });
}

test('STK-UX-01/R1 mede o alvo efetivo do mini-segmented', async ({ page }, info) => {
  await boot(page);
  await importRoutes(page);
  await telegram(page);
  await page.goto(`/miniapp#miniapp?import=${importId}`);
  await expect(page.getByRole('heading', { name: 'Editar aposta' })).toBeVisible();

  const measurement = await page.evaluate(() => {
    const groups = Array.from(document.querySelectorAll<HTMLElement>('.mini-segmented'));
    return groups.map((group) => {
      const groupRect = group.getBoundingClientRect();
      const csGroup = getComputedStyle(group);
      const labels = Array.from(group.querySelectorAll<HTMLLabelElement>('label'), (label) => {
        const r = label.getBoundingClientRect();
        const cs = getComputedStyle(label);
        const input = label.querySelector('input');
        const inputRect = input?.getBoundingClientRect();
        return {
          text: (label.textContent ?? '').trim(),
          // alvo acionável = <label> (input é pointer-events:none)
          width: Math.round(r.width * 100) / 100,
          height: Math.round(r.height * 100) / 100,
          cursor: cs.cursor,
          inputPointerEvents: input ? getComputedStyle(input).pointerEvents : null,
          inputOpacity: input ? getComputedStyle(input).opacity : null,
          inputWidth: inputRect ? Math.round(inputRect.width * 100) / 100 : null,
          inputHeight: inputRect ? Math.round(inputRect.height * 100) / 100 : null,
          cssMinHeight: cs.minHeight,
        };
      });
      const rects = Array.from(group.querySelectorAll<HTMLLabelElement>('label'), (l) =>
        l.getBoundingClientRect(),
      );
      // espaçamento (gap efetivo) entre alvos vizinhos — critério 2.5.8(b)
      const gaps: number[] = [];
      for (let i = 1; i < rects.length; i += 1) {
        const prev = rects[i - 1]!;
        const cur = rects[i]!;
        gaps.push(Math.round((cur.left - prev.right) * 100) / 100);
      }
      return {
        ariaLabel: group.getAttribute('aria-label'),
        role: group.getAttribute('role'),
        gridTemplateColumns: csGroup.gridTemplateColumns,
        gap: csGroup.gap,
        padding: csGroup.padding,
        groupWidth: Math.round(groupRect.width * 100) / 100,
        labels,
        horizontalGaps: gaps,
      };
    });
  });

  const summary = { viewport: page.viewportSize(), groups: measurement };
  const path = info.outputPath('target-size.json');
  const fs = await import('node:fs');
  fs.writeFileSync(path, JSON.stringify(summary, null, 2), 'utf8');
  console.log('TARGET_SIZE_JSON=' + path);
  console.log(JSON.stringify(summary, null, 2));
  expect(measurement.length).toBeGreaterThan(0);
});
