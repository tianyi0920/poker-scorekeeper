import { fireEvent, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
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

it('disables every dismiss path when configured as non-dismissible', () => {
  // Break caught: a busy mutation can be aborted locally while the server may still commit it.
  const onClose = vi.fn();
  const view = render(<Modal title="正在保存" dismissible={false} onClose={onClose}><button type="button">等待</button></Modal>);

  expect(screen.getByRole('button', { name: '关闭' })).toBeDisabled();
  fireEvent.keyDown(document, { key: 'Escape' });
  fireEvent.mouseDown(view.container.querySelector('.modal-backdrop')!);
  fireEvent.click(screen.getByRole('button', { name: '关闭' }));

  expect(onClose).not.toHaveBeenCalled();
});

it('keeps close button, Escape and backdrop dismissal enabled by default', () => {
  // Break caught: adding the mutation lock accidentally makes existing dialogs impossible to close.
  const onClose = vi.fn();
  const view = render(<Modal title="普通对话框" onClose={onClose}><button type="button">确认</button></Modal>);

  expect(screen.getByRole('button', { name: '关闭' })).toBeEnabled();
  fireEvent.keyDown(document, { key: 'Escape' });
  fireEvent.mouseDown(view.container.querySelector('.modal-backdrop')!);
  fireEvent.click(screen.getByRole('button', { name: '关闭' }));

  expect(onClose).toHaveBeenCalledTimes(3);
});
