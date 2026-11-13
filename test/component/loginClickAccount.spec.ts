import { expect, test } from './fixtures';

// 实验：state=account（汽水/qq 已登录显示账号视图）+ 点击最下面未登录行 → 右侧从账号切表单/二维码 → 窗口高度变化。
const WIDTH = 1000;

test('account state: click last row keeps the window', async ({ page, mount }) => {
    await page.setViewportSize({ width: WIDTH, height: 470 });
    await mount('loginWindow', { state: 'account', count: 8, lang: 'en', motion: 'off' });
    const list = page.getByRole('dialog').getByRole('listbox');
    await expect(list.locator('[data-row]')).toHaveCount(8);

    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const last = list.locator('[data-row]').last();
    await last.click();
    await page.waitForTimeout(600);

    expect(errors).toEqual([]);
    await expect(list).toBeVisible();
});
