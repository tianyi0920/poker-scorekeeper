import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { HoldemCardPicker } from './HoldemCardPicker.js';

it('collects the three flop cards while preventing a card already visible elsewhere', async () => {
  // Break caught: the grouped flop picker accepts too few cards or allows the same physical card twice.
  const confirm = vi.fn();
  render(<HoldemCardPicker
    title="选择翻牌（3张）"
    initialCards={[]}
    requiredCount={3}
    excludedCards={['As']}
    onClose={() => undefined}
    onClear={() => undefined}
    onConfirm={confirm}
  />);
  const user = userEvent.setup();
  const confirmButton = screen.getByRole('button', { name: '确认选牌' });

  expect(confirmButton).toBeDisabled();
  await user.click(screen.getByRole('button', { name: '选择点数 A' }));
  expect(screen.getByRole('button', { name: '选择花色 黑桃' })).toBeDisabled();
  await user.click(screen.getByRole('button', { name: '选择花色 红桃' }));
  await user.click(screen.getByRole('button', { name: '选择点数 K' }));
  await user.click(screen.getByRole('button', { name: '选择花色 黑桃' }));
  await user.click(screen.getByRole('button', { name: '选择点数 Q' }));
  await user.click(screen.getByRole('button', { name: '选择花色 梅花' }));

  expect(screen.getByLabelText('已选择的牌')).toHaveTextContent('A♥K♠Q♣');
  expect(confirmButton).toBeEnabled();
  await user.click(confirmButton);
  expect(confirm).toHaveBeenCalledWith(['Ah', 'Ks', 'Qc']);
});

it('clears the whole target group through an explicit action', async () => {
  // Break caught: replacing cards is possible but removing a player or street from the local calculation is not.
  const clear = vi.fn();
  render(<HoldemCardPicker
    title="修改手牌"
    initialCards={['Ad', 'Kc']}
    requiredCount={2}
    excludedCards={[]}
    onClose={() => undefined}
    onClear={clear}
    onConfirm={() => undefined}
  />);

  await userEvent.setup().click(screen.getByRole('button', { name: '清空本组' }));
  expect(clear).toHaveBeenCalledOnce();
});
