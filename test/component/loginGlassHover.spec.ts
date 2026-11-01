import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures';

// test/component/loginGlassHover.spec.ts
// 黑屏主线：真机「液态玻璃 + 登录窗口」悬停最下面一行 → React #185（更新深度超限）→ 界面空白。
// 官方 #913 修复（measureRow 除缩放 + sameBox 0.01px 容差）在无玻璃的 probe 环境通过，真机仍崩。
// 本测试给 loginWindow.probe 挂上玻璃宿主（GlassFilterDefs + useGlass + 常驻 data-glass 三连元素，
// 模拟真机 App 根的液态玻璃机制），在同一溢出高度档悬停最后一行，看是否复现 #185。

const WIDTH = 1000;

const measure = (list: Locator) => list.evaluate((element) => {
    const rows = element.querySelectorAll<HTMLElement>('[data-row]');
    const last = rows[rows.length - 1];
    const listTop = element.getBoundingClientRect().top + element.clientTop;
    const box = last.getBoundingClientRect();
    return {
        rows: rows.length,
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight,
        realBottom: box.bottom - listTop,
        roundedBottom: last.offsetTop + last.offsetHeight,
    };
});

async function findOverflowingHeight(page: Page, list: Locator): Promise<number> {
    for (let height = 440; height <= 600; height += 1) {
        await page.setViewportSize({ width: WIDTH, height });
        const seen = await measure(list);
        if (seen.scrollHeight === seen.clientHeight && Math.abs(seen.realBottom - seen.clientHeight) < 0.01 && seen.roundedBottom > seen.clientHeight) {
            return height;
        }
    }
    throw new Error('no window height in 440–600 makes the last row round past the list');
}

test('glass host: hovering the last of 8 platform rows must not blow past React #185', async ({ page, mount }) => {
    await page.setViewportSize({ width: WIDTH, height: 470 });
    await mount('loginWindow', { count: 8, lang: 'en', motion: 'off', glass: 'on' });
    const list = page.getByRole('dialog').getByRole('listbox');
    await expect(list.locator('[data-row]')).toHaveCount(8);
    await findOverflowingHeight(page, list);

    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const last = list.locator('[data-row]').last();
    await last.hover();
    await expect(list).toHaveAttribute('aria-activedescendant', await last.getAttribute('id') ?? '');

    expect(errors, errors.join('\n')).toEqual([]);
    await expect(list).toBeVisible();
    const after = await measure(list);
    expect(after.scrollHeight).toBe(after.clientHeight);
});
