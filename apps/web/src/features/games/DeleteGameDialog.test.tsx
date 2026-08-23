import type { ManagedGameDto } from '@poker/contracts';
import { fireEvent, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { jsonResponse } from '../../test/app-fixtures.js';
import { DeleteGameDialog } from './DeleteGameDialog.js';

const game: ManagedGameDto = {
  id: 'game-1',
  name: '测试局',
  status: 'ACTIVE',
  createdAt: '2026-08-24T10:00:00.000+08:00',
  startedAt: '2026-08-24T10:05:00.000+08:00',
  completedAt: null,
  playerCount: 4
};

afterEach(() => vi.unstubAllGlobals());

it('shows one confirmation and locks every dismissal path during the single delete request', async () => {
  // Break caught: confirmation opens another dialog or can be dismissed/resubmitted while DELETE may commit.
  let finishDelete!: (response: Response) => void;
  const pendingDelete = new Promise<Response>((resolve) => { finishDelete = resolve; });
  const fetchMock = vi.fn(() => pendingDelete);
  vi.stubGlobal('fetch', fetchMock);
  const onCancel = vi.fn();
  const onDeleted = vi.fn();

  render(<DeleteGameDialog game={game} onCancel={onCancel} onDeleted={onDeleted} />);
  const dialog = screen.getByRole('dialog', { name: '永久删除对局' });
  expect(dialog).toHaveTextContent('测试局');
  expect(dialog).toHaveTextContent('进行中');
  expect(dialog).toHaveTextContent('购买记录、玩家锁、结算草稿、结算结果及费用分摊将一并永久删除，无法恢复。');
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  expect(screen.queryByText('再次确认')).not.toBeInTheDocument();

  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: '确认永久删除' }));

  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock).toHaveBeenCalledWith(
    '/api/games/game-1',
    expect.objectContaining({ method: 'DELETE' })
  );
  expect(screen.getByRole('button', { name: '正在永久删除…' })).toBeDisabled();
  expect(screen.getByRole('button', { name: '取消' })).toBeDisabled();
  expect(screen.getByRole('button', { name: '关闭' })).toBeDisabled();

  fireEvent.keyDown(document, { key: 'Escape' });
  fireEvent.mouseDown(document.querySelector('.modal-backdrop')!);
  fireEvent.click(screen.getByRole('button', { name: '正在永久删除…' }));
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(onCancel).not.toHaveBeenCalled();

  finishDelete(jsonResponse({ deletedGameId: 'game-1' }));
  await vi.waitFor(() => expect(onDeleted).toHaveBeenCalledWith(game));
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it('keeps the same dialog open with the server Chinese error and allows an explicit retry', async () => {
  // Break caught: a failed delete closes the dialog or retries without another user confirmation.
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(jsonResponse({ code: 'GAME_STATE_CONFLICT' }, 409))
    .mockResolvedValueOnce(jsonResponse({ deletedGameId: 'game-1' }));
  vi.stubGlobal('fetch', fetchMock);

  function Harness() {
    const [target, setTarget] = useState<ManagedGameDto | null>(game);
    return target === null
      ? null
      : <DeleteGameDialog game={target} onCancel={() => setTarget(null)} onDeleted={() => setTarget(null)} />;
  }

  const user = userEvent.setup();
  render(<Harness />);
  await user.click(screen.getByRole('button', { name: '确认永久删除' }));

  expect(await screen.findByRole('alert')).toHaveTextContent('对局状态已变化，请刷新后重试');
  expect(screen.getByRole('dialog', { name: '永久删除对局' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '确认永久删除' })).toBeEnabled();
  expect(fetchMock).toHaveBeenCalledTimes(1);

  await user.click(screen.getByRole('button', { name: '确认永久删除' }));
  await vi.waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(fetchMock).toHaveBeenCalledTimes(2);
});
