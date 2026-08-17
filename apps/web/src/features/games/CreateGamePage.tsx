import { useCallback, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import type { GameSnapshotDto } from '@poker/contracts';
import { mutationMessage, scorekeeperApi } from '../../api/resources.js';
import { Button } from '../../components/Button.js';
import { Card } from '../../components/Card.js';
import { Modal } from '../../components/Modal.js';
import { Toast } from '../../components/Toast.js';

type Intent = 'draft' | 'start';

export function CreateGamePage() {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [handPrice, setHandPrice] = useState('300');
  const [rakeEnabled, setRakeEnabled] = useState(true);
  const [pendingGame, setPendingGame] = useState<GameSnapshotDto | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const closeModal = useCallback(() => setPendingGame(null), []);

  async function create(requestedIntent: Intent) {
    if (!/^[1-9]\d*$/.test(handPrice)) {
      setError('每手金额必须是大于 0 的整数元');
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const game = await scorekeeperApi.createGame({
        ...(name.trim() ? { name: name.trim() } : {}),
        handPrice,
        rakeEnabled
      });
      if (requestedIntent === 'start') setPendingGame(game);
      else navigate(`/games/${encodeURIComponent(game.id)}`);
    } catch (reason) {
      setError(mutationMessage(reason, '创建对局失败，请稍后重试'));
    } finally {
      setSubmitting(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void create('draft');
  }

  async function confirmStart() {
    if (pendingGame === null) return;
    setSubmitting(true);
    setError(null);
    try {
      const started = await scorekeeperApi.startGame(pendingGame.id);
      navigate(`/games/${encodeURIComponent(started.id)}`);
    } catch (reason) {
      setError(mutationMessage(reason, '开启对局失败，请稍后重试'));
      setPendingGame(null);
    } finally {
      setSubmitting(false);
    }
  }

  return <div className="page-stack narrow-page">
    <div className="page-title"><span className="section-kicker">NEW TABLE</span><h2>创建对局</h2><p>先设置这一桌的基础规则，开启后即可邀请大家入座。</p></div>
    <Card><form className="form-stack" onSubmit={submit}>
      {error !== null && <Toast tone="error" message={error} />}
      <label className="field" htmlFor="game-name">对局名称（选填）<input id="game-name" aria-label="对局名称（选填）" maxLength={40} value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：8月17日晚场" /><small>名称由服务器自动生成，也可以手动填写</small></label>
      <label className="field" htmlFor="hand-price">每手金额<input id="hand-price" aria-label="每手金额" inputMode="numeric" type="number" min="1" step="1" value={handPrice} onChange={(event) => setHandPrice(event.target.value)} required /><small>默认 ¥300，只接受整数元</small></label>
      <label className="toggle-row" htmlFor="rake-enabled"><span><strong>启用抽成</strong><small>结算时按实时抽成规则计算</small></span><input id="rake-enabled" aria-label="启用抽成" type="checkbox" checked={rakeEnabled} onChange={(event) => setRakeEnabled(event.target.checked)} /></label>
      <div className="button-stack">
        <Button type="submit" variant="secondary" unsafe disabled={submitting}>创建草稿</Button>
        <Button type="button" unsafe disabled={submitting} onClick={() => void create('start')}>创建并立即开启</Button>
      </div>
    </form></Card>
    {pendingGame !== null && <Modal title="确认开启对局" onClose={closeModal}>
      <div className="modal-body"><p><strong>{pendingGame.name}</strong> 创建成功。开启后会计入最多两场进行中对局。</p><div className="button-stack"><Button unsafe disabled={submitting} onClick={() => void confirmStart()}>确认开启</Button><Button variant="ghost" onClick={closeModal}>暂不开启</Button></div></div>
    </Modal>}
  </div>;
}
