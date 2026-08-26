import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

const expectedChineseCopyByFile: Record<string, readonly string[]> = {
  'src/app/AppShell.tsx': ['朋友牌局'],
  'src/features/games/CreateGamePage.tsx': ['新建牌桌'],
  'src/features/games/GamePage.tsx': ['实时牌桌'],
  'src/features/settings/RakeSettingsPage.tsx': ['抽成规则'],
  'src/features/home/HomePage.tsx': ['实时牌桌', '历史战绩'],
  'src/features/profile/ProfilePage.tsx': ['个人中心'],
  'src/features/history/AllPlayerSummaryPage.tsx': ['战绩汇总'],
  'src/features/history/GameSelectionPage.tsx': ['选择对局'],
  'src/features/history/HistoryPage.tsx': ['历史记录'],
  'src/features/history/MonthlyRankingPage.tsx': ['月度排名'],
  'src/features/history/SettlementDetailPage.tsx': ['结算已锁定'],
  'src/features/settlements/SettlementWizardPage.tsx': ['对局结算'],
  'src/features/users/UserFormPage.tsx': ['新建用户', '用户资料'],
  'src/features/users/UserListPage.tsx': ['成员管理']
};

it('keeps production section kickers Chinese instead of restoring the previous English copy', () => {
  // Break caught: a user-visible section kicker is reverted or no longer shows its agreed Chinese copy.
  const productionCopyByFile = Object.fromEntries(
    Object.keys(expectedChineseCopyByFile).map((file) => [file, readFileSync(resolve(process.cwd(), file), 'utf8')])
  );
  for (const [file, expectedCopy] of Object.entries(expectedChineseCopyByFile)) {
    for (const copy of expectedCopy) expect(productionCopyByFile[file], file).toContain(copy);
  }
  const source = Object.values(productionCopyByFile).join('\n');
  const remainingEnglishCopy = [
    'MIDNIGHT TABLE', 'LIVE TABLES', 'LIVE TABLE', 'RAKE RULE', 'PROFILE',
    'SETTLEMENT WIZARD', 'SELECT GAMES', 'ALL PLAYER SUMMARY', 'NEW MEMBER',
    'MEMBER PROFILE', 'NEW TABLE', 'TEAM', 'HISTORY', 'LOCKED SETTLEMENT'
  ].filter((copy) => source.includes(copy));

  expect(remainingEnglishCopy).toEqual([]);
});
