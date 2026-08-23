import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { ProfilePage } from './ProfilePage.js';

const refreshSession = vi.fn(async () => null);

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
    onChanged: (avatar: { kind: 'PRESET' | 'UPLOAD'; value: string }) => void;
  }) => <div>
    <output>{currentAvatar === null ? 'missing' : `${currentAvatar.kind}:${currentAvatar.value}`}</output>
    <button type="button" onClick={() => onChanged({ kind: 'PRESET', value: 'preset-13' })}>保存头像</button>
  </div>
}));

afterEach(() => {
  refreshSession.mockClear();
});

it('initializes the picker from the authenticated avatar and refreshes the session after a save', async () => {
  const user = userEvent.setup();
  render(<MemoryRouter><ProfilePage /></MemoryRouter>);

  expect(screen.getByText('UPLOAD:saved-avatar.webp')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: '保存头像' }));

  expect(refreshSession).toHaveBeenCalledOnce();
});
