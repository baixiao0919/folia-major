import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures';

// 实验：点击最后一行后窗口高度变化（模拟从账号视图切到表单登录视图），看是否触发测量循环黑屏。
const WIDTH = 1000;

test('click last row then window height changes keeps the window', async ({ page, mount }) => {
    await page.setViewportSize({ width: WIDTH, height: 470 });
    await mount('loginWindow', { count: 8, lang: 'en', motion: 'off' });
    const list = page.getByRole('dialog').getByRole('listbox');
    await expect(list.locator('[data-row]')).toHaveCount(8);

    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const last = list.locator('[data-row]').last();
    await last.click();
    // 点击后窗口高度变化（右侧面板切换的模拟）
    await page.setViewportSize({ width: WIDTH, height: 520 });
    await page.waitForTimeout(500);
    await page.setViewportSize({ width: WIDTH, height: 470 });
    await page.waitForTimeout(500);

    expect(errors).toEqual([]);
    await expect(list).toBeVisible();
});
