import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { ProfilePage } from './ProfilePage.js';

const refreshSession = vi.fn(async () => null);
let avatarChanged: ((avatar: { kind: 'PRESET' | 'UPLOAD'; value: string }) => Promise<void> | void) | undefined;

vi.mock('../../auth/AuthProvider.js', () => ({
  useAuth: () => ({
    user: {
      id: 'user-1',
      username: 'avatar-user',
      nickname: '头像用户',
      role: 'USER',
      mustChangePassword: false,
      avatarKind: 'UPLOAD',
      avatarValue: 'saved-avatar.webp'
    },
    refreshSession
  })
}));

vi.mock('./AvatarPicker.js', () => ({
  AvatarPicker: ({
    currentAvatar,
    onChanged
  }: {
    currentAvatar: { kind: string; value: string } | null;
    onChanged: (avatar: { kind: 'PRESET' | 'UPLOAD'; value: string }) => Promise<void> | void;
  }) => {
    avatarChanged = onChanged;
    return <div>
    <output>{currentAvatar === null ? 'missing' : `${currentAvatar.kind}:${currentAvatar.value}`}</output>
    <button type="button" onClick={() => void onChanged({ kind: 'PRESET', value: 'preset-13' })}>保存头像</button>
  </div>;
  }
}));

afterEach(() => {
  refreshSession.mockClear();
  avatarChanged = undefined;
});

it('initializes the picker from the authenticated avatar and refreshes the session after a save', async () => {
  const user = userEvent.setup();
  render(<MemoryRouter><ProfilePage /></MemoryRouter>);

  expect(screen.getByText('UPLOAD:saved-avatar.webp')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: '保存头像' }));

  expect(refreshSession).toHaveBeenCalledOnce();
});

it('returns the pending session refresh to the avatar picker', async () => {
  // Break caught: ProfilePage fire-and-forgets refreshSession, allowing AvatarPicker to unlock before the echo.
  let resolveRefresh!: (value: null) => void;
  const pendingRefresh = new Promise<null>((resolve) => { resolveRefresh = resolve; });
  refreshSession.mockReturnValueOnce(pendingRefresh);
  render(<MemoryRouter><ProfilePage /></MemoryRouter>);

  const result = avatarChanged?.({ kind: 'PRESET', value: 'preset-13' });

  expect(result).toBeInstanceOf(Promise);
  let settled = false;
  void result?.then(() => { settled = true; });
  await Promise.resolve();
  expect(settled).toBe(false);
  resolveRefresh(null);
  await result;
  expect(settled).toBe(true);
});
