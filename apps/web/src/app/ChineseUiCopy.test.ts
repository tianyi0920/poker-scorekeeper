import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

const visibleCopyFiles = [
  'src/app/AppShell.tsx',
  'src/features/games/CreateGamePage.tsx',
  'src/features/games/GamePage.tsx',
  'src/features/settings/RakeSettingsPage.tsx',
  'src/features/home/HomePage.tsx',
  'src/features/profile/ProfilePage.tsx',
  'src/features/history/AllPlayerSummaryPage.tsx',
  'src/features/history/GameSelectionPage.tsx',
  'src/features/history/HistoryPage.tsx',
  'src/features/history/SettlementDetailPage.tsx',
  'src/features/settlements/SettlementWizardPage.tsx',
  'src/features/users/UserFormPage.tsx',
  'src/features/users/UserListPage.tsx'
] as const;

it('keeps production section kickers Chinese instead of restoring the previous English copy', () => {
  // Break caught: a user-visible section kicker is reverted to the previous English UI copy.
  const source = visibleCopyFiles
    .map((file) => readFileSync(resolve(process.cwd(), file), 'utf8'))
    .join('\n');
  const remainingEnglishCopy = [
    'MIDNIGHT TABLE', 'LIVE TABLES', 'LIVE TABLE', 'RAKE RULE', 'PROFILE',
    'SETTLEMENT WIZARD', 'SELECT GAMES', 'ALL PLAYER SUMMARY', 'NEW MEMBER',
    'MEMBER PROFILE', 'NEW TABLE', 'TEAM', 'HISTORY', 'LOCKED SETTLEMENT'
  ].filter((copy) => source.includes(copy));

  expect(remainingEnglishCopy).toEqual([]);
});
