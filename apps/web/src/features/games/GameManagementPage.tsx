import type { ManagedGameDto } from '@poker/contracts';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { mutationMessage, scorekeeperApi } from '../../api/resources.js';
import { Button } from '../../components/Button.js';
import { Card } from '../../components/Card.js';
import { Toast } from '../../components/Toast.js';
import { DeleteGameDialog, managedGameStatusLabels } from './DeleteGameDialog.js';

function appendUniqueGames(current: ManagedGameDto[], incoming: ManagedGameDto[]): ManagedGameDto[] {
  const ids = new Set(current.map((game) => game.id));
  return [...current, ...incoming.filter((game) => {
    if (ids.has(game.id)) return false;
    ids.add(game.id);
    return true;
  })];
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).format(new Date(value));
}

function GameDestination({ game }: { game: ManagedGameDto }) {
  if (game.status === 'ACTIVE') {
    return <Link className="secondary-link" to={`/games/${encodeURIComponent(game.id)}`}>进入牌桌</Link>;
  }
  if (game.status === 'SETTLING') {
    return <Link className="secondary-link" to={`/games/${encodeURIComponent(game.id)}/settlement`}>进入结算</Link>;
  }
  if (game.status === 'COMPLETED') {
    return <Link className="secondary-link" to={`/history/${encodeURIComponent(game.id)}`}>查看历史</Link>;
  }
  return null;
}

export function GameManagementPage() {
  const mounted = useRef(true);
  const [items, setItems] = useState<ManagedGameDto[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [moreError, setMoreError] = useState(false);
  const [reload, setReload] = useState(0);
  const [deleteTarget, setDeleteTarget] = useState<ManagedGameDto | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    mounted.current = true;
    let active = true;
    setItems([]);
    setNextCursor(null);
    setLoading(true);
    setLoadingMore(false);
    setError(null);
    setMoreError(false);
    void scorekeeperApi.managedGames(50).then((response) => {
      if (!active) return;
      setItems(appendUniqueGames([], response.items));
      setNextCursor(response.nextCursor);
    }).catch((reason) => {
      if (active) setError(mutationMessage(reason, '对局列表加载失败，请稍后重试'));
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => {
      active = false;
      mounted.current = false;
    };
  }, [reload]);

  async function loadMore() {
    if (nextCursor === null || loadingMore) return;
    setLoadingMore(true);
    setError(null);
    setMoreError(false);
    try {
      const response = await scorekeeperApi.managedGames(50, nextCursor);
      if (!mounted.current) return;
      setItems((current) => appendUniqueGames(current, response.items));
      setNextCursor(response.nextCursor);
    } catch (reason) {
      if (!mounted.current) return;
      setError(mutationMessage(reason, '更多对局加载失败，请稍后重试'));
      setMoreError(true);
    } finally {
      if (mounted.current) setLoadingMore(false);
    }
  }

  function finishDelete(game: ManagedGameDto) {
    setItems((current) => current.filter((item) => item.id !== game.id));
    setDeleteTarget(null);
    setSuccess(`已永久删除“${game.name}”`);
  }

  return <section className="page-stack" aria-labelledby="game-management-title">
    <header className="page-title"><h2 id="game-management-title">对局管理</h2><p>查看全部状态的对局，并谨慎处理永久删除。</p></header>
    {success !== null && <Toast tone="success" message={success} />}
    {error !== null && <Toast tone="error" message={error} />}
    {loading
      ? <p className="muted" role="status">正在加载对局…</p>
      : items.length === 0 && error === null
        ? <Card className="empty-card"><p>还没有对局</p></Card>
        : <div className="management-game-list">{items.map((game) => {
          const titleId = `managed-game-${game.id}`;
          return <article className="card management-game-card" aria-labelledby={titleId} key={game.id}>
            <header className="management-game-heading"><h3 id={titleId}>{game.name}</h3><span className={`management-status management-status--${game.status.toLowerCase()}`}>{managedGameStatusLabels[game.status]}</span></header>
            <dl className="management-game-meta">
              <div><dt>创建时间</dt><dd><time dateTime={game.createdAt}>{formatDateTime(game.createdAt)}</time></dd></div>
              {game.startedAt !== null && <div><dt>开始时间</dt><dd><time dateTime={game.startedAt}>{formatDateTime(game.startedAt)}</time></dd></div>}
              {game.completedAt !== null && <div><dt>完成时间</dt><dd><time dateTime={game.completedAt}>{formatDateTime(game.completedAt)}</time></dd></div>}
              <div><dt>玩家人数</dt><dd>{game.playerCount} 人</dd></div>
            </dl>
            <div className="management-game-actions"><GameDestination game={game} /><Button variant="danger" unsafe aria-label={`永久删除 ${game.name}`} onClick={() => { setSuccess(null); setDeleteTarget(game); }}>永久删除</Button></div>
          </article>;
        })}</div>}
    {!loading && error !== null && !moreError && <Button variant="secondary" onClick={() => setReload((value) => value + 1)}>重试加载</Button>}
    {!loading && nextCursor !== null && <Button variant="secondary" disabled={loadingMore} onClick={() => void loadMore()}>{loadingMore ? '正在加载更多…' : moreError ? '重试加载更多' : '加载更多'}</Button>}
    {deleteTarget !== null && <DeleteGameDialog game={deleteTarget} onCancel={() => setDeleteTarget(null)} onDeleted={finishDelete} />}
  </section>;
}
