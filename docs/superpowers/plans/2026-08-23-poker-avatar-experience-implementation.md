# Poker Avatar Experience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the native file-input presentation with a polished album/crop/upload/retry flow, add attractive license-safe cartoon presets, and make preset changes explicit and reliably reflected in the signed-in profile.

**Architecture:** Preserve `PRESET` and `UPLOAD` persistence. Extend the preset catalog from legacy IDs 01-12 to selectable Lorelei IDs 13-24, keep old assets renderable, and expose the authenticated user's current avatar through the session contract. Treat preset choice as local pending state until the user presses `保存头像`; treat an upload as saved only after the server response succeeds.

**Tech Stack:** React 19, NestJS 11, Zod 4, Sharp, DiceBear Lorelei SVG API, Vitest, Testing Library, Playwright, pnpm.

**Spec:** `docs/superpowers/specs/2026-08-22-poker-scorekeeper-ux-hard-delete-design.md`

## Global Constraints

- Preserve rendering for existing `preset-01` through `preset-12` users.
- Expose only `preset-13` through `preset-24` in the new selection grid.
- Use a license-safe, reproducible upstream source and commit attribution/source metadata.
- The browser's native file-input label must never be visible; the real input remains accessible through the styled button.
- Upload progress, crop, failure state, and retry are mandatory; a failed upload must not discard the user's crop.
- Preset changes require an explicit save action and must not issue a mutation while the user is only browsing choices.
- Uploaded files continue through the existing validation, size, MIME, orientation, resize, storage, and cleanup pipeline.

---

## File Structure

- Modify `packages/contracts/src/avatars.ts`: legacy/renderable and selectable preset schemas.
- Modify `packages/contracts/src/auth.ts`: authenticated avatar reference.
- Modify API auth mappers/tests: return current avatar in login, refresh, and password-change sessions.
- Create `scripts/generate-preset-avatars.mjs`: deterministic DiceBear Lorelei downloader/converter.
- Create `apps/web/public/avatars/README.md`: source URL, seeds, license, generation command.
- Create `apps/web/public/avatars/preset-13.webp` through `preset-24.webp`.
- Modify `apps/api/src/uploads/preset-avatars.ts` and avatar tests: new default and selectable catalog.
- Modify `apps/web/src/features/profile/ProfilePage.tsx`: initialize from the authenticated session.
- Modify `AvatarPicker.tsx`, `AvatarCropDialog.tsx`, and tests: staged preset save, styled album action, progress, retained retry.
- Modify `apps/web/src/styles/global.css`: selection, progress, crop-error, and mobile states.
- Modify `tests/e2e/avatar.spec.ts`: preset-save and upload-retry user journeys.

### Task 1: Carry the current avatar through the auth session

**Files:**
- Modify: `packages/contracts/src/avatars.ts`
- Create: `packages/contracts/src/avatars.test.ts`
- Modify: `packages/contracts/src/auth.ts`
- Modify: `apps/api/src/common/auth/auth-user.ts`
- Modify: `apps/api/src/auth/auth.service.ts`
- Modify: `apps/api/src/auth/session.service.ts`
- Modify: `apps/api/src/auth/session.service.test.ts`
- Modify: `apps/api/test/auth.e2e-spec.ts`
- Modify: `apps/web/src/features/profile/ProfilePage.tsx`

**Interfaces:**
- Produces: `RenderablePresetAvatarId = preset-01..preset-24`.
- Produces: `SelectablePresetAvatarId = preset-13..preset-24`.
- Produces: `AuthUserContract.avatarKind: 'PRESET' | 'UPLOAD'` and `avatarValue: string`.

- [ ] **Step 1: Add failing contract tests for both catalogs**

```ts
it('keeps legacy preset ids renderable but not newly selectable', () => {
  expect(renderablePresetAvatarIdSchema.safeParse('preset-01').success).toBe(true);
  expect(selectablePresetAvatarIdSchema.safeParse('preset-01').success).toBe(false);
  expect(selectablePresetAvatarIdSchema.safeParse('preset-13').success).toBe(true);
  expect(selectablePresetAvatarIdSchema.safeParse('preset-24').success).toBe(true);
});

it('requires the current avatar in authenticated sessions', () => {
  expect(authUserSchema.parse({
    id: 'u1', username: 'test', nickname: '测试', role: 'USER',
    mustChangePassword: false, avatarKind: 'PRESET', avatarValue: 'preset-13',
  })).toMatchObject({ avatarKind: 'PRESET', avatarValue: 'preset-13' });
});
```

- [ ] **Step 2: Run contract tests and verify they fail**

Run: `pnpm --filter @poker/contracts test -- avatars.test.ts`

Expected: FAIL because only 01-12 exist and auth sessions omit the avatar.

- [ ] **Step 3: Split renderable and selectable schemas**

```ts
export const legacyPresetAvatarIdSchema = z.enum([
  'preset-01', 'preset-02', 'preset-03', 'preset-04', 'preset-05', 'preset-06',
  'preset-07', 'preset-08', 'preset-09', 'preset-10', 'preset-11', 'preset-12',
]);

export const selectablePresetAvatarIdSchema = z.enum([
  'preset-13', 'preset-14', 'preset-15', 'preset-16', 'preset-17', 'preset-18',
  'preset-19', 'preset-20', 'preset-21', 'preset-22', 'preset-23', 'preset-24',
]);

export const renderablePresetAvatarIdSchema = z.union([
  legacyPresetAvatarIdSchema,
  selectablePresetAvatarIdSchema,
]);

export const selectPresetAvatarSchema = z.object({
  presetId: selectablePresetAvatarIdSchema,
});
```

Add `avatarKind` and `avatarValue` to `authUserSchema`, `AuthUser`, both `toAuthUser` mapper input shapes, and mapper returns.

- [ ] **Step 4: Add session and E2E mapper assertions**

Test login, refresh, and forced-password-change responses. Each must return the database avatar exactly; an upload filename must not be rewritten as a preset ID.

Run:

```bash
pnpm --filter @poker/contracts test -- avatars.test.ts
pnpm --filter @poker/api test -- session.service.test.ts
pnpm --filter @poker/api test:e2e -- auth.e2e-spec.ts
```

Expected: PASS.

- [ ] **Step 5: Initialize ProfilePage from authenticated state and commit**

```tsx
const currentAvatar = user
  ? { kind: user.avatarKind, value: user.avatarValue }
  : null;

<AvatarPicker currentAvatar={currentAvatar} onChanged={handleAvatarChanged} />
```

After `onChanged`, call `refreshSession()` so every subsequent render and navigation uses the saved server value. Do not keep a separate page-only avatar initialized to `null`.

```bash
git add packages/contracts/src/avatars.ts packages/contracts/src/avatars.test.ts packages/contracts/src/auth.ts apps/api/src/common/auth/auth-user.ts apps/api/src/auth/auth.service.ts apps/api/src/auth/session.service.ts apps/api/src/auth/session.service.test.ts apps/api/test/auth.e2e-spec.ts apps/web/src/features/profile/ProfilePage.tsx
git commit -m "feat: expose current avatar in auth sessions"
```

### Task 2: Add reproducible Lorelei cartoon presets

**Files:**
- Create: `scripts/generate-preset-avatars.mjs`
- Modify: `package.json`
- Create: `apps/web/public/avatars/README.md`
- Create: `apps/web/public/avatars/preset-13.webp`
- Create: `apps/web/public/avatars/preset-14.webp`
- Create: `apps/web/public/avatars/preset-15.webp`
- Create: `apps/web/public/avatars/preset-16.webp`
- Create: `apps/web/public/avatars/preset-17.webp`
- Create: `apps/web/public/avatars/preset-18.webp`
- Create: `apps/web/public/avatars/preset-19.webp`
- Create: `apps/web/public/avatars/preset-20.webp`
- Create: `apps/web/public/avatars/preset-21.webp`
- Create: `apps/web/public/avatars/preset-22.webp`
- Create: `apps/web/public/avatars/preset-23.webp`
- Create: `apps/web/public/avatars/preset-24.webp`
- Modify: `apps/api/src/uploads/preset-avatars.ts`
- Modify: `apps/api/src/uploads/avatar.service.test.ts`

**Asset source:** DiceBear Lorelei, CC0 1.0. Use the official v10 API endpoint and the fixed seeds below. The README must link the exact style documentation and CC0 license and record the retrieval date.

**Fixed seeds:** `Amber`, `Coco`, `Daisy`, `Emery`, `Felix`, `Ginger`, `Hazel`, `Jasper`, `Kiki`, `Luna`, `Milo`, `Nova`.

- [ ] **Step 1: Add failing avatar-service tests for the new catalog**

```ts
it('exposes only the twelve new selectable presets', () => {
  expect(PRESET_AVATARS.map(({ id }) => id)).toEqual([
    'preset-13', 'preset-14', 'preset-15', 'preset-16', 'preset-17', 'preset-18',
    'preset-19', 'preset-20', 'preset-21', 'preset-22', 'preset-23', 'preset-24',
  ]);
  expect(DEFAULT_PRESET_AVATAR).toBe('preset-13');
});

it('rejects selecting a legacy preset while continuing to render it', async () => {
  await expect(service.selectPreset(actor, 'preset-01')).rejects.toMatchObject({
    status: 400,
  });
  expect(renderAvatarUrl('PRESET', 'preset-01')).toBe('/avatars/preset-01.webp');
});
```

- [ ] **Step 2: Run the focused test**

Run: `pnpm --filter @poker/api test -- avatar.service.test.ts`

Expected: FAIL because the current selectable/default range is 01-12.

- [ ] **Step 3: Add the deterministic generator**

```js
// scripts/generate-preset-avatars.mjs
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const requireFromApi = createRequire(new URL('../apps/api/package.json', import.meta.url));
const sharp = requireFromApi('sharp');
const seeds = ['Amber', 'Coco', 'Daisy', 'Emery', 'Felix', 'Ginger',
  'Hazel', 'Jasper', 'Kiki', 'Luna', 'Milo', 'Nova'];
const outputDir = path.resolve('apps/web/public/avatars');
await mkdir(outputDir, { recursive: true });

for (const [offset, seed] of seeds.entries()) {
  const id = `preset-${String(offset + 13).padStart(2, '0')}`;
  const url = new URL('https://api.dicebear.com/10.x/lorelei/svg');
  url.searchParams.set('seed', seed);
  url.searchParams.set('backgroundColor', 'b6e3f4,c0aede,d1d4f9,ffd5dc,ffdfbf');
  const response = await fetch(url, { headers: { 'User-Agent': 'poker-scorekeeper-avatar-generator' } });
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  const svg = Buffer.from(await response.arrayBuffer());
  await sharp(svg).resize(256, 256, { fit: 'cover' }).webp({ quality: 88 })
    .toFile(path.join(outputDir, `${id}.webp`));
}
```

The script must fail on any non-2xx response and write no alternate random seeds. Add the root package script `"avatars:generate": "node scripts/generate-preset-avatars.mjs"`, and document `pnpm avatars:generate` verbatim in the asset README.

- [ ] **Step 4: Generate and visually verify the 12 assets**

Run: `pnpm avatars:generate`

Expected: twelve 256x256 WebP files named 13-24, each non-empty.

Create a temporary contact sheet outside the repository, inspect it visually, then delete only that temporary sheet. Verify faces are distinct, centered, free of text/logos, and legible at 48x48.

- [ ] **Step 5: Change the new-user default and selection catalog**

```ts
export const DEFAULT_PRESET_AVATAR: SelectablePresetAvatarId = 'preset-13';
export const PRESET_AVATARS = SELECTABLE_PRESET_IDS.map((id) => ({
  id,
  path: `/avatars/${id}.webp`,
}));
```

Update `UsersService` create defaults and bootstrap defaults that currently use `preset-01` or `default` to `preset-13`. Do not rewrite existing rows.

- [ ] **Step 6: Re-run, check asset metadata, and commit**

Run:

```bash
pnpm --filter @poker/api test -- avatar.service.test.ts
node -e "const fs=require('fs'); for(let n=13;n<=24;n++){const p='apps/web/public/avatars/preset-'+n+'.webp'; if(fs.statSync(p).size<1000) throw new Error(p)}"
```

Expected: PASS.

```bash
git add package.json scripts/generate-preset-avatars.mjs apps/web/public/avatars/README.md apps/web/public/avatars/preset-13.webp apps/web/public/avatars/preset-14.webp apps/web/public/avatars/preset-15.webp apps/web/public/avatars/preset-16.webp apps/web/public/avatars/preset-17.webp apps/web/public/avatars/preset-18.webp apps/web/public/avatars/preset-19.webp apps/web/public/avatars/preset-20.webp apps/web/public/avatars/preset-21.webp apps/web/public/avatars/preset-22.webp apps/web/public/avatars/preset-23.webp apps/web/public/avatars/preset-24.webp apps/api/src/uploads/preset-avatars.ts apps/api/src/uploads/avatar.service.test.ts apps/api/src/users/users.service.ts apps/api/src/auth/bootstrap-admin.service.ts
git commit -m "feat: add licensed cartoon avatar presets"
```

### Task 3: Stage preset choice until explicit save

**Files:**
- Modify: `apps/web/src/features/profile/AvatarPicker.tsx`
- Modify: `apps/web/src/features/profile/AvatarPicker.test.tsx`
- Modify: `apps/web/src/styles/global.css`

**State model:**
- `savedAvatar`: last value confirmed by the server.
- `pendingPreset`: selected grid item not yet saved.
- `isSaving`: disables both preset and upload mutations.
- Save button visible and enabled only when `pendingPreset !== savedAvatar.value`.

- [ ] **Step 1: Add failing explicit-save tests**

```tsx
it('does not save when a preset is only selected', async () => {
  const user = userEvent.setup();
  renderPicker({ currentAvatar: { kind: 'PRESET', value: 'preset-13' } });
  await user.click(screen.getByRole('radio', { name: '头像 14' }));
  expect(fetchMock).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: '保存头像' })).toBeEnabled();
});

it('saves the pending preset once and refreshes the saved selection', async () => {
  const user = userEvent.setup();
  renderPicker({ currentAvatar: { kind: 'PRESET', value: 'preset-13' } });
  await user.click(screen.getByRole('radio', { name: '头像 14' }));
  await user.click(screen.getByRole('button', { name: '保存头像' }));
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(onChanged).toHaveBeenCalledWith({ kind: 'PRESET', value: 'preset-14' });
  expect(screen.queryByRole('button', { name: '保存头像' })).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run the focused test**

Run: `pnpm --filter @poker/web test -- AvatarPicker.test.tsx`

Expected: FAIL because selecting a preset currently saves immediately.

- [ ] **Step 3: Implement radio semantics and save/cancel state**

Use a `radiogroup` labelled `默认头像`. Each option exposes checked state. Show `保存头像` and `取消修改` after a changed selection. `取消修改` restores the saved avatar without a request. Disable the grid and buttons while saving, and render an inline error with a `重试保存` button on mutation failure.

- [ ] **Step 4: Re-run and commit**

Run: `pnpm --filter @poker/web test -- AvatarPicker.test.tsx`

Expected: PASS.

```bash
git add apps/web/src/features/profile/AvatarPicker.tsx apps/web/src/features/profile/AvatarPicker.test.tsx apps/web/src/styles/global.css
git commit -m "feat: add explicit preset avatar save"
```

### Task 4: Replace native file UI with album, crop, progress, and retained retry

**Files:**
- Modify: `apps/web/src/features/profile/AvatarPicker.tsx`
- Modify: `apps/web/src/features/profile/AvatarPicker.test.tsx`
- Modify: `apps/web/src/features/profile/AvatarCropDialog.tsx`
- Modify: `apps/web/src/features/profile/AvatarCropDialog.test.tsx`
- Modify: `apps/web/src/api/avatar-upload.test.ts`
- Modify: `apps/web/src/styles/global.css`

- [ ] **Step 1: Add failing accessible file-button and retry tests**

```tsx
it('uses a styled album button and hides native file-input text', () => {
  renderPicker();
  expect(screen.getByRole('button', { name: '从相册选择' })).toBeVisible();
  expect(screen.queryByText('未选择任何文件')).not.toBeInTheDocument();
  const input = screen.getByLabelText('从相册选择文件');
  expect(input).toHaveClass('visually-hidden-file-input');
  expect(input).toHaveAttribute('accept', 'image/jpeg,image/png,image/webp');
});

it('keeps the crop and retries the same blob after upload failure', async () => {
  uploadAvatar.mockRejectedValueOnce(new Error('network'))
    .mockResolvedValueOnce({ avatarKind: 'UPLOAD', avatarValue: 'saved.webp' });
  await chooseAndCropImage();
  expect(screen.getByText('上传失败，请重试')).toBeVisible();
  await userEvent.click(screen.getByRole('button', { name: '重新上传' }));
  expect(uploadAvatar).toHaveBeenCalledTimes(2);
  expect(uploadAvatar.mock.calls[1][0]).toBe(uploadAvatar.mock.calls[0][0]);
});
```

- [ ] **Step 2: Run the focused web tests**

Run: `pnpm --filter @poker/web test -- AvatarPicker.test.tsx AvatarCropDialog.test.tsx avatar-upload.test.ts`

Expected: FAIL on native presentation and retained retry.

- [ ] **Step 3: Implement the styled input and upload state machine**

The visible `从相册选择` button calls the hidden input's `.click()`. After selection, open the existing crop dialog. After crop confirmation, store both the source preview URL and cropped `Blob` until success or explicit cancel.

Render progress as:

```tsx
<div className="avatar-upload-progress" role="status" aria-live="polite">
  <progress value={progress} max={100} aria-label="头像上传进度" />
  <span>正在上传 {progress}%</span>
</div>
```

On error, keep the preview/crop result and show `重新上传` plus `重新选择`. Revoke object URLs only after successful save, explicit discard, replacement selection, or unmount.

- [ ] **Step 4: Verify keyboard and failure behavior**

Run: `pnpm --filter @poker/web test -- AvatarPicker.test.tsx AvatarCropDialog.test.tsx avatar-upload.test.ts`

Expected: PASS. Keyboard Tab reaches `从相册选择`, preset radios, save/cancel, crop controls, and retry actions in visual order.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/features/profile/AvatarPicker.tsx apps/web/src/features/profile/AvatarPicker.test.tsx apps/web/src/features/profile/AvatarCropDialog.tsx apps/web/src/features/profile/AvatarCropDialog.test.tsx apps/web/src/api/avatar-upload.test.ts apps/web/src/styles/global.css
git commit -m "feat: polish avatar upload and retry flow"
```

### Task 5: Verify avatar persistence end to end

**Files:**
- Modify: `tests/e2e/avatar.spec.ts`

- [ ] **Step 1: Add explicit-save and reload scenarios**

The preset scenario must select 14, assert no request-side success indication yet, press `保存头像`, reload, and confirm 14 remains selected.

The upload scenario must choose the existing E2E fixture through the hidden input, crop, observe upload progress, and assert the uploaded image persists after reload.

- [ ] **Step 2: Add a failed-upload retry scenario**

Intercept the first upload request with a 503, assert `上传失败，请重试`, remove the intercept, press `重新上传`, and assert success without opening the file picker or crop dialog again.

- [ ] **Step 3: Run E2E and package verification**

Run:

```bash
pnpm test:e2e -- avatar.spec.ts
pnpm --filter @poker/contracts test
pnpm --filter @poker/contracts typecheck
pnpm --filter @poker/api lint
pnpm --filter @poker/api typecheck
pnpm --filter @poker/api test
pnpm --filter @poker/web lint
pnpm --filter @poker/web typecheck
pnpm --filter @poker/web test
pnpm --filter @poker/web build
```

Expected: all commands exit 0.

- [ ] **Step 4: Commit E2E coverage**

```bash
git add tests/e2e/avatar.spec.ts
git commit -m "test: cover avatar save and upload retry"
```

## Visual Acceptance Checklist

- New users receive `preset-13`; existing users on 01-12 still render correctly.
- The grid offers exactly 12 new cartoon presets with visible selected and saved states.
- Choosing a preset does not save until `保存头像` is pressed.
- No native `选择文件/未选择任何文件` chrome is visible on desktop or mobile.
- Crop preview remains available after a failed upload and retry does not reopen the picker.
- Upload progress and errors are announced to assistive technology.
- Reloading the page displays the persisted preset or uploaded avatar from the auth session.
