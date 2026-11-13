import { expect, test } from './fixtures';

// 补真机组合缺口：液态玻璃 + 点击最后一行（触发 login:chosen → login 状态 batch 更新）
// 真机崩溃链：click 行 → startLogin → login 状态更新 → 渲染阶段 setState 循环 → React #185
const WIDTH = 1000;

test('glass + click last row keeps window', async ({ page, mount }) => {
    await page.setViewportSize({ width: WIDTH, height: 470 });
    await mount('loginWindow', { count: 8, state: 'account', lang: 'en', motion: 'off', glass: 'on' });
    const list = page.getByRole('dialog').getByRole('listbox');
    await expect(list.locator('[data-row]')).toHaveCount(8);

    const dialog = page.getByRole('dialog');
    const heightBefore = await dialog.evaluate(el => el.getBoundingClientRect().height);

    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    // 依次点击最后一行（真机用户操作：点最下面一行）
    await list.locator('[data-row="spotify"]').click();
    await page.waitForTimeout(500);
    await list.locator('[data-row="ytm"]').click();
    await page.waitForTimeout(500);
    await list.locator('[data-row="flymusic"]').click();
    await page.waitForTimeout(800);

    expect(errors).toEqual([]);
    await expect(list).toBeVisible();
    const heightAfter = await dialog.evaluate(el => el.getBoundingClientRect().height);
    console.log(`dialog height before=${heightBefore} after=${heightAfter} errors=${errors.length}`);
});
