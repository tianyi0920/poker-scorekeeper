import {
  gameJoinAckSchema,
  gameSnapshotSchema,
  presenceUpdatedEventSchema,
  type GameSnapshotDto
} from '@poker/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { createGameSocket, type GameSocketClient, type GameSocketListener } from '../../api/game-socket.js';
import { mutationMessage, scorekeeperApi } from '../../api/resources.js';
import { useAuth } from '../../auth/AuthProvider.js';
import { Button } from '../../components/Button.js';
import { Modal } from '../../components/Modal.js';
import { Toast } from '../../components/Toast.js';
import { AdjustBuyInDialog } from '../buyins/AdjustBuyInDialog.js';
import { BuyInSheet } from '../buyins/BuyInSheet.js';
import { GameTimer } from './GameTimer.js';
import { PurchaseTimeline } from './PurchaseTimeline.js';
import { RoundTable } from './RoundTable.js';
import { SpectatorBar } from './SpectatorBar.js';

type GameTab = 'table' | 'purchases';
type SocketFactory = () => GameSocketClient;

function totalBuyIn(snapshot: GameSnapshotDto): bigint {
  return snapshot.players.reduce((total, player) => total + BigInt(player.buyInAmount), 0n);
}

export function GamePage({ socketFactory = createGameSocket }: { socketFactory?: SocketFactory }) {
  const { id: gameId = '' } = useParams();
  const { user } = useAuth();
  const [snapshot, setSnapshot] = useState<GameSnapshotDto | null>(null);
  const snapshotRef = useRef<GameSnapshotDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [socketReady, setSocketReady] = useState(false);
  const [connected, setConnected] = useState(false);
  const [polling, setPolling] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [tab, setTab] = useState<GameTab>('table');
  const [buyOpen, setBuyOpen] = useState(false);
  const [adjustment, setAdjustment] = useState<{ playerId: string; currentHands: number } | null>(null);
  const [endOpen, setEndOpen] = useState(false);
  const [ending, setEnding] = useState(false);
  const [endError, setEndError] = useState<string | null>(null);
  const hasSnapshot = snapshot !== null;

  const applySnapshot = useCallback((candidate: unknown): boolean => {
    const parsed = gameSnapshotSchema.safeParse(candidate);
    if (!parsed.success || parsed.data.id !== gameId) return false;
    const current = snapshotRef.current;
    if (current !== null && parsed.data.version < current.version) return false;
    snapshotRef.current = parsed.data;
    setSnapshot(parsed.data);
    return true;
  }, [gameId]);

  const loadSnapshot = useCallback(async (background = false) => {
    if (!background) setLoadError(null);
    try {
      const response = await scorekeeperApi.gameSnapshot(gameId);
      if (!applySnapshot(response)) throw new Error('Invalid game snapshot');
    } catch {
      if (!background) setLoadError('对局暂时无法加载，请稍后重试');
    } finally {
      if (!background) setLoading(false);
    }
  }, [applySnapshot, gameId]);

  useEffect(() => {
    if (gameId === '') {
      setLoadError('对局不存在');
      setLoading(false);
      return;
    }
    void loadSnapshot();
  }, [gameId, loadSnapshot]);

  useEffect(() => {
    if (!hasSnapshot) return;
    const socket = socketFactory();
    setSocketReady(true);

    const join = () => {
      setConnected(true);
      setPolling(false);
      setConnectionError(null);
      socket.emit('game.join', {
        gameId,
        knownVersion: snapshotRef.current?.version ?? 0
      }, (value) => {
        const acknowledgement = gameJoinAckSchema.safeParse(value);
        if (!acknowledgement.success || !acknowledgement.data.ok) {
          setConnectionError('实时同步暂时不可用，页面会自动尝试恢复。');
        }
      });
    };
    const disconnect = () => setConnected(false);
    const receiveSnapshot = (value: unknown) => { applySnapshot(value); };
    const receivePresence = (value: unknown) => {
      const parsed = presenceUpdatedEventSchema.safeParse(value);
      if (!parsed.success || parsed.data.gameId !== gameId) return;
      setSnapshot((current) => {
        if (current === null) return current;
        const next = { ...current, spectators: parsed.data.spectators };
        snapshotRef.current = next;
        return next;
      });
    };
    const refreshRules = () => { void loadSnapshot(true); };
    const socketError = () => {
      setConnected(false);
      setConnectionError('实时连接中断，正在尝试恢复。');
    };

    const listeners: Array<[string, GameSocketListener]> = [
      ['connect', join],
      ['disconnect', disconnect],
      ['connect_error', socketError],
      ['game.snapshot', receiveSnapshot],
      ['game.updated', receiveSnapshot],
      ['presence.updated', receivePresence],
      ['rake-settings.updated', refreshRules],
      ['player-rake.updated', refreshRules],
      ['server.error', socketError]
    ];
    for (const [event, listener] of listeners) socket.on(event, listener);
    socket.connect();

    return () => {
      if (socket.connected) socket.emit('game.leave', { gameId });
      for (const [event, listener] of listeners) socket.off(event, listener);
      socket.disconnect();
      setSocketReady(false);
      setConnected(false);
    };
  }, [applySnapshot, gameId, hasSnapshot, loadSnapshot, socketFactory]);

  useEffect(() => {
    if (!socketReady || connected) {
      setPolling(false);
      return;
    }
    const fallback = window.setTimeout(() => setPolling(true), 5_000);
    return () => window.clearTimeout(fallback);
  }, [connected, socketReady]);

  useEffect(() => {
    if (!polling) return;
    void loadSnapshot(true);
    const interval = window.setInterval(() => { void loadSnapshot(true); }, 10_000);
    return () => window.clearInterval(interval);
  }, [loadSnapshot, polling]);

  const refreshAfterWrite = () => {
    void loadSnapshot(true);
  };

  if (loading) return <div className="page-status">正在摆好牌桌…</div>;
  if (snapshot === null) {
    return <section className="page-stack"><Toast tone="error" message={loadError ?? '对局不存在'} /><Link className="action-link" to="/">返回首页</Link></section>;
  }

  const selfPlayer = snapshot.players.find(({ userId }) => user?.id === userId);
  const active = snapshot.status === 'ACTIVE';
  const fullForViewer = snapshot.players.length >= 12 && selfPlayer === undefined;
  const canManage = user?.role === 'ADMIN' || user?.role === 'SUPER_ADMIN';

  const beginSettlement = async () => {
    if (!active || !canManage || ending) return;
    setEnding(true);
    setEndError(null);
    try {
      const next = await scorekeeperApi.beginSettlement(snapshot.id);
      if (!applySnapshot(next)) throw new Error('Invalid game snapshot');
      setEndOpen(false);
    } catch (reason) {
      setEndError(mutationMessage(reason, '暂时无法结束对局，请刷新后重试'));
    } finally {
      setEnding(false);
    }
  };

  return (
    <section className="game-page" aria-labelledby="game-title">
      <header className="game-heading">
        <div><span className="section-kicker">LIVE TABLE</span><h2 id="game-title">{snapshot.name}</h2></div>
        <div className="game-heading-actions">
          <span className={active ? 'live-pill' : 'status-pill status-pill--settling'}>{active ? '进行中' : '结算中'}</span>
          {active && canManage && <Button variant="ghost" unsafe onClick={() => setEndOpen(true)}>结束对局</Button>}
        </div>
      </header>

      {!connected && socketReady && (
        <div className="connection-banner" role="status" aria-label="实时连接状态">
          <span className="connection-dot" aria-hidden="true" />
          {polling ? '实时连接中断，已启用每 10 秒定期同步' : connectionError ?? '正在连接实时牌桌…'}
        </div>
      )}

      <div className="game-tabs" role="tablist" aria-label="对局内容">
        <button role="tab" aria-selected={tab === 'table'} onClick={() => setTab('table')}>对战区</button>
        <button role="tab" aria-selected={tab === 'purchases'} onClick={() => setTab('purchases')}>
          购买记录 <span>{snapshot.purchases.length}</span>
        </button>
      </div>

      {tab === 'table' ? (
        <div role="tabpanel" className="battle-panel">
          <RoundTable players={snapshot.players} selfUserId={user?.id ?? ''}>
            <span>已开局</span>
            <strong><GameTimer startedAt={snapshot.startedAt} stoppedAt={snapshot.stoppedAt} serverNow={snapshot.serverNow} /></strong>
            <dl>
              <div><dt>每手</dt><dd>¥{snapshot.handPrice}</dd></div>
              <div><dt>全桌总买入</dt><dd>¥{totalBuyIn(snapshot).toString()}</dd></div>
            </dl>
          </RoundTable>
          <SpectatorBar spectators={snapshot.spectators} />
        </div>
      ) : (
        <div role="tabpanel" className="timeline-panel">
          <PurchaseTimeline
            purchases={snapshot.purchases}
            players={snapshot.players}
            selfUserId={user?.id ?? ''}
            handPrice={snapshot.handPrice}
            canAdjust={active}
            onAdjust={(playerId, currentHands) => setAdjustment({ playerId, currentHands })}
          />
        </div>
      )}

      {active && (
        <div className="game-action-dock">
          <Button unsafe disabled={fullForViewer} onClick={() => setBuyOpen(true)}>
            {fullForViewer ? '本桌已满' : '购买筹码'}
          </Button>
        </div>
      )}

      <BuyInSheet
        gameId={snapshot.id}
        handPrice={snapshot.handPrice}
        open={buyOpen}
        onClose={() => setBuyOpen(false)}
        onSuccess={refreshAfterWrite}
      />
      {adjustment !== null && (
        <AdjustBuyInDialog
          gameId={snapshot.id}
          playerId={adjustment.playerId}
          currentHands={adjustment.currentHands}
          open
          onClose={() => setAdjustment(null)}
          onSuccess={refreshAfterWrite}
        />
      )}
      {endOpen && active && canManage && (
        <Modal title="确认结束对局" onClose={() => { if (!ending) setEndOpen(false); }}>
          <div className="modal-body end-game-confirmation">
            <Toast tone="info" message="确认后立即停止计时并禁止购买与更正，随后进入结算。" />
            {endError !== null && <Toast tone="error" message={endError} />}
            <Button variant="danger" unsafe disabled={ending} onClick={() => void beginSettlement()}>
              {ending ? '正在结束…' : '确认结束并进入结算'}
            </Button>
            <Button variant="ghost" disabled={ending} onClick={() => setEndOpen(false)}>继续对局</Button>
          </div>
        </Modal>
      )}
    </section>
  );
}
