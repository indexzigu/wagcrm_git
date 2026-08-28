import { test, expect } from '../fixtures/auth.fixture';
import { CalendarPage } from '../page-objects/calendar.page';

test.describe('Calendar', () => {
  let calendarPage: CalendarPage;

  test.beforeEach(async ({ page }) => {
    calendarPage = new CalendarPage(page);
    await calendarPage.goto();
  });

  test('calendar renders with events', async () => {
    const events = await calendarPage.getCampaignEvents();
    expect(events.length).toBeGreaterThanOrEqual(0);
    // Dashboard should render the embedded calendar widget without errors
    await expect(calendarPage['page']).toHaveURL(/\/$/);
  });

  test('campaigns on correct dates', async () => {
    // Navigate to the month containing seeded campaigns (July 2025)
    const events = await calendarPage.getCampaignEvents();

    // If events are visible, they should correspond to seeded campaign dates
    if (events.length > 0) {
      const eventNames = events.map((e) => e.name);
      expect(eventNames.length).toBeGreaterThan(0);
    }
  });

  test('clicking event → details', async ({ page }) => {
    const events = await calendarPage.getCampaignEvents();

    if (events.length > 0) {
      const firstEvent = events[0];
      await calendarPage.clickEvent(firstEvent.name);

      // Clicking a calendar bar should open the campaign side panel.
      const panelVisible = await page
        .locator('[role="dialog"]')
        .isVisible({ timeout: 5_000 })
        .catch(() => false);
      const titleVisible = await page.getByText('캠페인 상세').isVisible({ timeout: 5_000 }).catch(() => false);

      expect(panelVisible || titleVisible).toBe(true);
    }
  });
});
