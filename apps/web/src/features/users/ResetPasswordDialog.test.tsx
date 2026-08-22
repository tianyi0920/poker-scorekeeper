import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { ResetPasswordDialog } from './ResetPasswordDialog.js';

afterEach(() => vi.unstubAllGlobals());

it('prefills an editable agreed temporary password without resetting on dialog open', async () => {
  // Break caught: opening reset either omits the agreed default, prevents an override, or submits a reset without confirmation.
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const user = userEvent.setup();
  render(<ResetPasswordDialog userId="user-1" nickname="阿明" onClose={vi.fn()} />);

  const password = screen.getByLabelText('新临时密码');
  expect(password).toHaveValue('12345678');
  expect(fetch).not.toHaveBeenCalled();
  await user.clear(password);
  await user.type(password, 'changed-password');
  expect(password).toHaveValue('changed-password');
});
