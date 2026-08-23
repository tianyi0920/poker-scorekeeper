import type { ManagedGameDto } from '@poker/contracts';
import { useState } from 'react';
import { mutationMessage, scorekeeperApi } from '../../api/resources.js';
import { Button } from '../../components/Button.js';
import { Modal } from '../../components/Modal.js';
import { Toast } from '../../components/Toast.js';

export const managedGameStatusLabels = {
  DRAFT: '草稿',
  ACTIVE: '进行中',
  SETTLING: '结算中',
  COMPLETED: '已完成',
  VOIDED: '已作废'
} as const;

export function DeleteGameDialog({ game, onCancel, onDeleted }: {
  game: ManagedGameDto;
  onCancel: () => void;
  onDeleted: (game: ManagedGameDto) => void;
}) {
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirmDelete() {
    if (deleting) return;
    setDeleting(true);
    setError(null);
    try {
      await scorekeeperApi.hardDeleteGame(game.id);
      onDeleted(game);
    } catch (reason) {
      setError(mutationMessage(reason, '永久删除失败，请稍后重试'));
      setDeleting(false);
    }
  }

  return <Modal title="永久删除对局" dismissible={!deleting} onClose={onCancel}>
    <div className="modal-body">
      <p>你将永久删除 <strong>“{game.name}”</strong>，当前状态：<strong>{managedGameStatusLabels[game.status]}</strong>。</p>
      <div className="irreversible-warning"><p>购买记录、玩家锁、结算草稿、结算结果及费用分摊将一并永久删除，无法恢复。</p></div>
      {error !== null && <Toast tone="error" message={error} />}
      <div className="button-stack">
        <Button variant="danger" unsafe disabled={deleting} onClick={() => void confirmDelete()}>{deleting ? '正在永久删除…' : '确认永久删除'}</Button>
        <Button variant="ghost" disabled={deleting} onClick={onCancel}>取消</Button>
      </div>
    </div>
  </Modal>;
}
