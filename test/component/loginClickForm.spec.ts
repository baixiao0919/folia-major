import { expect, test } from './fixtures';

// 实验：真实 8 平台（飞牛在最下，有 getLoginForm）+ 已登录账号视图 + 点击飞牛 → scene 切 form
// 观察：无 pageerror、窗口仍在、FormLogin 渲染、窗口高度变化
const WIDTH = 1000;

test('click flymusic (form) from account view keeps window', async ({ page, mount }) => {
    await page.setViewportSize({ width: WIDTH, height: 470 });
    await mount('loginWindow', { count: 8, state: 'account', lang: 'en', motion: 'off' });
    const list = page.getByRole('dialog').getByRole('listbox');
    await expect(list.locator('[data-row]')).toHaveCount(8);

    const dialog = page.getByRole('dialog');
    const heightBefore = await dialog.evaluate(el => el.getBoundingClientRect().height);

    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await list.locator('[data-row="flymusic"]').click();
    await page.waitForTimeout(800);

    expect(errors).toEqual([]);
    await expect(list).toBeVisible();
    const text = (await dialog.textContent()) ?? '';
    expect(text).toContain('Log in to 飞牛');
    const heightAfter = await dialog.evaluate(el => el.getBoundingClientRect().height);
    console.log(`dialog height before=${heightBefore} after=${heightAfter}`);
});
