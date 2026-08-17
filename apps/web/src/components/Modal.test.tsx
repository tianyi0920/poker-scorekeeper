import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { expect, it } from 'vitest';
import { useState } from 'react';
import { Modal } from './Modal.js';

function ModalHarness() {
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" onClick={() => setOpen(true)}>打开对话框</button>
    {open && <Modal title="确认操作" onClose={() => setOpen(false)}><button type="button">确认</button></Modal>}
  </>;
}

it('focuses the close control on open and restores the trigger after Escape', async () => {
  // Break caught: keyboard users lose their prior focus after closing the dialog.
  const user = userEvent.setup();
  render(<ModalHarness />);
  const trigger = screen.getByRole('button', { name: '打开对话框' });

  await user.click(trigger);
  expect(screen.getByRole('button', { name: '关闭' })).toHaveFocus();
  await user.keyboard('{Escape}');

  expect(screen.queryByRole('dialog', { name: '确认操作' })).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
});

it('cycles Tab and Shift+Tab within the dialog controls', async () => {
  // Break caught: Tab can escape an open modal into background controls.
  const user = userEvent.setup();
  render(<ModalHarness />);
  await user.click(screen.getByRole('button', { name: '打开对话框' }));
  const close = screen.getByRole('button', { name: '关闭' });
  const confirm = screen.getByRole('button', { name: '确认' });

  await user.tab({ shift: true });
  expect(confirm).toHaveFocus();
  await user.tab();
  expect(close).toHaveFocus();
});
