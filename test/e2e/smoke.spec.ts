import { test, expect } from './fixtures';

test('the app opens and the core answers', async ({ gb }) => {
  await expect(gb.page.getByRole('heading', { name: 'GPU Bench' })).toBeVisible();
  await expect(gb.page.getByLabel('version')).toHaveText(/^v\d+\.\d+\.\d+$/);
});
