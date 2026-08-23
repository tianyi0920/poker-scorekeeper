import {
  gameJoinAckSchema,
  gameSnapshotSchema,
  gameSnapshotEventSchema,
  gameUpdatedEventSchema,
  playerRakeUpdatedEventSchema,
  presenceUpdatedEventSchema,
  rakeSettingsUpdatedEventSchema,
  serverErrorEventSchema,
  type GameSnapshotDto
} from '@poker/contracts';
import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
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
const moneyFormatter = new Intl.NumberFormat('zh-CN');

function totalBuyIn(snapshot: GameSnapshotDto): bigint {
  return snapshot.players.reduce((total, player) => total + BigInt(player.buyInAmount), 0n);
}

export function GamePage({ socketFactory = createGameSocket }: { socketFactory?: SocketFactory }) {
  const { id: gameId = '' } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [snapshot, setSnapshot] = useState<GameSnapshotDto | null>(null);
  const snapshotRef = useRef<GameSnapshotDto | null>(null);
  const activeGameIdRef = useRef(gameId);
  activeGameIdRef.current = gameId;
  const tableTabRef = useRef<HTMLButtonElement>(null);
  const purchaseTabRef = useRef<HTMLButtonElement>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [socketReady, setSocketReady] = useState(false);
  const [roomSynchronized, setRoomSynchronized] = useState(false);
  const [polling, setPolling] = useState(false);
  const [fallbackGeneration, setFallbackGeneration] = useState(0);
  const fallbackGenerationRef = useRef(0);
  const fallbackTimeoutRef = useRef<number | undefined>(undefined);
  const pollingIntervalRef = useRef<number | undefined>(undefined);
  const [tab, setTab] = useState<GameTab>('table');
  const [buyOpen, setBuyOpen] = useState(false);
  const [adjustment, setAdjustment] = useState<{ playerId: string; currentHands: number } | null>(null);
  const [endOpen, setEndOpen] = useState(false);
  const [ending, setEnding] = useState(false);
  const [endError, setEndError] = useState<string | null>(null);
  const hasSnapshot = snapshot?.id === gameId;

  const applySnapshot = useCallback((candidate: unknown): boolean => {
    const parsed = gameSnapshotSchema.safeParse(candidate);
    if (!parsed.success || parsed.data.id !== activeGameIdRef.current) return false;
    const current = snapshotRef.current;
    if (current !== null && parsed.data.version < current.version) return false;
    snapshotRef.current = parsed.data;
    setSnapshot(parsed.data);
    return true;
  }, []);

  const loadSnapshot = useCallback(async (background = false) => {
    const requestedGameId = gameId;
    if (!background) setLoadError(null);
    try {
      const response = await scorekeeperApi.gameSnapshot(requestedGameId);
      if (activeGameIdRef.current !== requestedGameId) return;
      if (!applySnapshot(response)) throw new Error('Invalid game snapshot');
    } catch {
      if (!background && activeGameIdRef.current === requestedGameId) {
        setLoadError('对局暂时无法加载，请稍后重试');
      }
    } finally {
      if (!background && activeGameIdRef.current === requestedGameId) setLoading(false);
    }
  }, [applySnapshot, gameId]);

  const stopFallback = useCallback(() => {
    if (fallbackTimeoutRef.current !== undefined) {
      window.clearTimeout(fallbackTimeoutRef.current);
      fallbackTimeoutRef.current = undefined;
    }
    if (pollingIntervalRef.current !== undefined) {
      window.clearInterval(pollingIntervalRef.current);
      pollingIntervalRef.current = undefined;
    }
    setPolling(false);
  }, []);

  const startFallbackGrace = useCallback(() => {
    stopFallback();
    const nextGeneration = fallbackGenerationRef.current + 1;
    fallbackGenerationRef.current = nextGeneration;
    setFallbackGeneration(nextGeneration);
    setRoomSynchronized(false);
  }, [stopFallback]);

  const ensureFallbackGrace = useCallback(() => {
    if (fallbackTimeoutRef.current !== undefined || pollingIntervalRef.current !== undefined) return;
    startFallbackGrace();
  }, [startFallbackGrace]);

  useEffect(() => {
    snapshotRef.current = null;
    setSnapshot(null);
    setLoading(true);
    setLoadError(null);
    setTab('table');
    setBuyOpen(false);
    setAdjustment(null);
    setEndOpen(false);
    if (gameId === '') {
      setLoadError('对局不存在');
      setLoading(false);
      return;
    }
    void loadSnapshot();
  }, [gameId, loadSnapshot]);

  useEffect(() => {
    if (snapshot !== null && snapshot.status !== 'ACTIVE') {
      setBuyOpen(false);
      setAdjustment(null);
      setEndOpen(false);
    }
  }, [snapshot]);

  useEffect(() => {
    if (!hasSnapshot) return;
    const socket = socketFactory();
    type JoinAttempt = { generation: number; timeout: number; acknowledged: boolean };
    let disposed = false;
    let activeJoin: JoinAttempt | undefined;
    let retryTimeout: number | undefined;
    let retryGeneration: number | undefined;
    let joinGeneration = 0;
    setSocketReady(true);

    const clearJoinTimers = () => {
      if (activeJoin !== undefined) window.clearTimeout(activeJoin.timeout);
      if (retryTimeout !== undefined) window.clearTimeout(retryTimeout);
      activeJoin = undefined;
      retryTimeout = undefined;
      retryGeneration = undefined;
    };
    const scheduleJoinRetry = (generation: number) => {
      if (disposed || !socket.connected || generation !== joinGeneration || retryGeneration !== generation || retryTimeout !== undefined) return;
      const retry = window.setTimeout(() => {
        if (disposed || generation !== joinGeneration || retryGeneration !== generation || retryTimeout !== retry) return;
        retryTimeout = undefined;
        retryGeneration = undefined;
        attemptJoin();
      }, 5_000);
      retryTimeout = retry;
    };
    const beginJoinRetry = () => {
      if (disposed || retryGeneration !== undefined) return;
      const nextRetryGeneration = joinGeneration + 1;
      joinGeneration = nextRetryGeneration;
      retryGeneration = nextRetryGeneration;
      ensureFallbackGrace();
      scheduleJoinRetry(nextRetryGeneration);
    };
    const failJoin = (attempt: JoinAttempt | undefined) => {
      if (disposed || attempt === undefined || activeJoin !== attempt || attempt.generation !== joinGeneration) return;
      attempt.acknowledged = true;
      window.clearTimeout(attempt.timeout);
      activeJoin = undefined;
      beginJoinRetry();
    };
    const failCurrentJoin = () => {
      if (activeJoin !== undefined) {
        failJoin(activeJoin);
        return;
      }
      beginJoinRetry();
    };
    const attemptJoin = () => {
      if (disposed || !socket.connected) return;
      const generation = joinGeneration + 1;
      joinGeneration = generation;
      if (activeJoin !== undefined) window.clearTimeout(activeJoin.timeout);
      activeJoin = undefined;
      if (retryTimeout !== undefined) window.clearTimeout(retryTimeout);
      retryTimeout = undefined;
      retryGeneration = undefined;
      setRoomSynchronized(false);
      const attempt = { generation, timeout: 0, acknowledged: false };
      const timeout = window.setTimeout(() => {
        if (disposed || activeJoin !== attempt || generation !== joinGeneration || attempt.acknowledged) return;
        failJoin(attempt);
      }, 3_000);
      attempt.timeout = timeout;
      activeJoin = attempt;
      socket.emit('game.join', {
        gameId,
        knownVersion: snapshotRef.current?.version ?? 0
      }, (value) => {
        if (disposed || activeJoin !== attempt || generation !== joinGeneration || !socket.connected || attempt.acknowledged) return;
        const acknowledgement = gameJoinAckSchema.safeParse(value);
        if (!acknowledgement.success
          || !acknowledgement.data.ok
          || acknowledgement.data.gameId !== gameId) {
          failJoin(attempt);
          return;
        }
        attempt.acknowledged = true;
        window.clearTimeout(timeout);
        activeJoin = undefined;
        stopFallback();
        setRoomSynchronized(true);
      });
    };
    const connect = () => {
      attemptJoin();
    };
    const disconnect = () => {
      joinGeneration += 1;
      clearJoinTimers();
      ensureFallbackGrace();
    };
    const receiveSnapshot = (value: unknown) => {
      const parsed = gameSnapshotEventSchema.safeParse(value);
      if (parsed.success) applySnapshot(parsed.data);
    };
    const receiveGameUpdate = (value: unknown) => {
      const parsed = gameUpdatedEventSchema.safeParse(value);
      if (parsed.success) applySnapshot(parsed.data);
    };
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
    const refreshRakeSettings = (value: unknown) => {
      if (rakeSettingsUpdatedEventSchema.safeParse(value).success) void loadSnapshot(true);
    };
    const refreshPlayerRake = (value: unknown) => {
      if (playerRakeUpdatedEventSchema.safeParse(value).success) void loadSnapshot(true);
    };
    const socketError = () => {
      failCurrentJoin();
    };
    const receiveServerError = (value: unknown) => {
      if (serverErrorEventSchema.safeParse(value).success) {
        failCurrentJoin();
      }
    };

    const listeners: Array<[string, GameSocketListener]> = [
      ['connect', connect],
      ['disconnect', disconnect],
      ['connect_error', socketError],
      ['game.snapshot', receiveSnapshot],
      ['game.updated', receiveGameUpdate],
      ['presence.updated', receivePresence],
      ['rake-settings.updated', refreshRakeSettings],
      ['player-rake.updated', refreshPlayerRake],
      ['server.error', receiveServerError]
    ];
    for (const [event, listener] of listeners) socket.on(event, listener);
    socket.connect();

    return () => {
      disposed = true;
      joinGeneration += 1;
      clearJoinTimers();
      if (socket.connected) socket.emit('game.leave', { gameId });
      for (const [event, listener] of listeners) socket.off(event, listener);
      socket.disconnect();
      setSocketReady(false);
      setRoomSynchronized(false);
    };
  }, [applySnapshot, ensureFallbackGrace, gameId, hasSnapshot, loadSnapshot, socketFactory, startFallbackGrace, stopFallback]);

  useEffect(() => {
    if (!socketReady || roomSynchronized) {
      stopFallback();
      return;
    }
    stopFallback();
    const generation = fallbackGeneration;
    fallbackTimeoutRef.current = window.setTimeout(() => {
      if (generation !== fallbackGenerationRef.current) return;
      fallbackTimeoutRef.current = undefined;
      setPolling(true);
      pollingIntervalRef.current = window.setInterval(() => { void loadSnapshot(true); }, 10_000);
    }, 5_000);
    return stopFallback;
  }, [fallbackGeneration, loadSnapshot, roomSynchronized, socketReady, stopFallback]);

  const refreshAfterWrite = () => {
    void loadSnapshot(true);
  };

  const onTabKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    let next: GameTab | null = null;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      next = tab === 'table' ? 'purchases' : 'table';
    } else if (event.key === 'Home') {
      next = 'table';
    } else if (event.key === 'End') {
      next = 'purchases';
    }
    if (next === null) return;
    event.preventDefault();
    setTab(next);
    (next === 'table' ? tableTabRef.current : purchaseTabRef.current)?.focus();
  };

  if (loading || (snapshot !== null && snapshot.id !== gameId)) return <div className="page-status">正在摆好牌桌…</div>;
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
      navigate(`/games/${encodeURIComponent(snapshot.id)}/settlement`, { replace: true });
    } catch (reason) {
      setEndError(mutationMessage(reason, '暂时无法结束对局，请刷新后重试'));
      void loadSnapshot(true);
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
          {snapshot.status === 'SETTLING' && canManage && <Link className="action-link" to={`/games/${encodeURIComponent(snapshot.id)}/settlement`}>继续结算</Link>}
        </div>
      </header>

      {polling && (
        <div className="connection-banner" role="status" aria-label="实时连接状态">
          <span className="connection-dot" aria-hidden="true" />
          实时连接中断，已启用每 10 秒定期同步
        </div>
      )}

      <div className="game-tabs" role="tablist" aria-label="对局内容">
        <button
          ref={tableTabRef}
          id="game-tab-table"
          role="tab"
          aria-controls="game-panel-table"
          aria-selected={tab === 'table'}
          tabIndex={tab === 'table' ? 0 : -1}
          onKeyDown={onTabKeyDown}
          onClick={() => setTab('table')}
        >对战区</button>
        <button
          ref={purchaseTabRef}
          id="game-tab-purchases"
          role="tab"
          aria-controls="game-panel-purchases"
          aria-selected={tab === 'purchases'}
          tabIndex={tab === 'purchases' ? 0 : -1}
          onKeyDown={onTabKeyDown}
          onClick={() => setTab('purchases')}
        >
          购买记录 <span>{snapshot.purchases.length}</span>
        </button>
      </div>

      {tab === 'table' ? (
        <div id="game-panel-table" role="tabpanel" aria-labelledby="game-tab-table" tabIndex={0} className="battle-panel">
          <dl className="game-table-summary" data-testid="game-table-summary">
            <div><dt className="visually-hidden">玩家</dt><dd>玩家 {snapshot.players.length}/12</dd></div>
            <div><dt className="visually-hidden">总买入</dt><dd>总买入 ¥{moneyFormatter.format(totalBuyIn(snapshot))}</dd></div>
            <div><dt className="visually-hidden">每手</dt><dd>每手 ¥{moneyFormatter.format(BigInt(snapshot.handPrice))}</dd></div>
            <div className="game-table-summary__timer"><dt className="visually-hidden">已开局</dt><dd>已开局 <GameTimer startedAt={snapshot.startedAt} stoppedAt={snapshot.stoppedAt} serverNow={snapshot.serverNow} /></dd></div>
          </dl>
          <RoundTable players={snapshot.players} selfUserId={user?.id ?? ''} />
          <SpectatorBar spectators={snapshot.spectators} />
        </div>
      ) : (
        <div id="game-panel-purchases" role="tabpanel" aria-labelledby="game-tab-purchases" tabIndex={0} className="timeline-panel">
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
        canWrite={active}
        onClose={() => setBuyOpen(false)}
        onSuccess={refreshAfterWrite}
      />
      {adjustment !== null && (
        <AdjustBuyInDialog
          gameId={snapshot.id}
          playerId={adjustment.playerId}
          currentHands={adjustment.currentHands}
          open
          canWrite={active}
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
