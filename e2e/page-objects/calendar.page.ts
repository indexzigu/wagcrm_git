import { type Page, type Locator } from '@playwright/test';
import { BasePage } from './base.page';

export interface CalendarEvent {
  name: string;
  element: Locator;
}

/**
 * CalendarPage encapsulates interactions with the dashboard calendar widget.
 * The standalone /calendar workspace no longer exists; calendar UX lives on /.
 */
export class CalendarPage extends BasePage {
  constructor(page: Page) {
    super(page);
  }

  /**
   * Navigate to the dashboard page that embeds the calendar widget.
   */
  async goto(): Promise<void> {
    await this.navigateTo('/');
  }

  /**
   * Get all campaign events displayed on the calendar.
   */
  async getCampaignEvents(): Promise<CalendarEvent[]> {
    await this.page.waitForLoadState('networkidle');
    const calendarCard = this.page.locator('section, div').filter({
      has: this.page.getByText('캠페인 일정 및 진행 현황'),
    }).first();
    const events = calendarCard.locator('div[class*="cursor-pointer"]').filter({ hasText: /.+/ });
    const totalCount = await events.count();
    const result: CalendarEvent[] = [];

    for (let i = 0; i < totalCount; i++) {
      const el = events.nth(i);
      const name = ((await el.textContent()) ?? '').trim();
      if (name) {
        result.push({ name, element: el });
      }
    }

    return result;
  }

  /**
   * Click a campaign event on the calendar by name.
   */
  async clickEvent(name: string): Promise<void> {
    const event = this.page.locator('div[class*="cursor-pointer"]').filter({ hasText: name }).first();
    await event.click();

    await this.waitForNetworkIdle();
  }

  /**
   * Navigate to the previous or next month on the calendar.
   */
  async navigateMonth(direction: 'prev' | 'next'): Promise<void> {
    if (direction === 'prev') {
      const prevButton = this.page.getByRole('button', { name: /이전|prev|←|</ }).first();
      await prevButton.click();
    } else {
      const nextButton = this.page.getByRole('button', { name: /다음|next|→|>/ }).first();
      await nextButton.click();
    }

    await this.waitForNetworkIdle();
  }
}
