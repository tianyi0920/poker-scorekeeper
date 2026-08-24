import {
  gameJoinAckSchema,
  gameDeletedEventSchema,
  gameMessageCreatedEventSchema,
  gameSnapshotSchema,
  gameSnapshotEventSchema,
  gameUpdatedEventSchema,
  playerRakeUpdatedEventSchema,
  presenceUpdatedEventSchema,
  rakeSettingsUpdatedEventSchema,
  serverErrorEventSchema,
  type GameMessageDto,
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
import { GameMessagesPanel } from './GameMessagesPanel.js';
import { GameSpeechSheet } from './GameSpeechSheet.js';
import { PurchaseTimeline } from './PurchaseTimeline.js';
import { RoundTable } from './RoundTable.js';
import { SpectatorBar } from './SpectatorBar.js';
import { GAME_DELETED_NOTICE } from './useGameDeletedSubscription.js';

type GameTab = 'table' | 'purchases' | 'messages';
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
  const messageTabRef = useRef<HTMLButtonElement>(null);
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
  const [messages, setMessages] = useState<GameMessageDto[]>([]);
  const [speechOpen, setSpeechOpen] = useState(false);
  const [buyOpen, setBuyOpen] = useState(false);
  const [adjustment, setAdjustment] = useState<{ playerId: string; currentHands: number } | null>(null);
  const [endOpen, setEndOpen] = useState(false);
  const [ending, setEnding] = useState(false);
  const [endError, setEndError] = useState<string | null>(null);
  const requestGenerationRef = useRef(0);
  const loadAbortControllersRef = useRef(new Set<AbortController>());
  const endAbortRef = useRef<AbortController | null>(null);
  const writeAbortRef = useRef(new AbortController());
  const deletedRef = useRef(false);
  const hasSnapshot = snapshot?.id === gameId;

  const abortPageRequests = useCallback(() => {
    for (const controller of loadAbortControllersRef.current) controller.abort();
    loadAbortControllersRef.current.clear();
    endAbortRef.current?.abort();
    endAbortRef.current = null;
    writeAbortRef.current.abort();
  }, []);

  const applySnapshot = useCallback((candidate: unknown): boolean => {
    const parsed = gameSnapshotSchema.safeParse(candidate);
    if (!parsed.success || parsed.data.id !== activeGameIdRef.current) return false;
    const current = snapshotRef.current;
    if (current !== null && parsed.data.version < current.version) return false;
    snapshotRef.current = parsed.data;
    setSnapshot(parsed.data);
    return true;
  }, []);

  const appendMessage = useCallback((message: GameMessageDto) => {
    setMessages((current) => current.some(({ id }) => id === message.id)
      ? current
      : [...current, message].slice(-50));
  }, []);

  const loadSnapshot = useCallback(async (background = false) => {
    const requestedGameId = gameId;
    const generation = requestGenerationRef.current;
    const controller = new AbortController();
    loadAbortControllersRef.current.add(controller);
    if (!background) setLoadError(null);
    try {
      const response = await scorekeeperApi.gameSnapshot(requestedGameId, controller.signal);
      if (controller.signal.aborted || deletedRef.current || requestGenerationRef.current !== generation || activeGameIdRef.current !== requestedGameId) return;
      if (!applySnapshot(response)) throw new Error('Invalid game snapshot');
    } catch {
      if (!controller.signal.aborted && !deletedRef.current && requestGenerationRef.current === generation && !background && activeGameIdRef.current === requestedGameId) {
        setLoadError('对局暂时无法加载，请稍后重试');
      }
    } finally {
      loadAbortControllersRef.current.delete(controller);
      if (!controller.signal.aborted && !deletedRef.current && requestGenerationRef.current === generation && !background && activeGameIdRef.current === requestedGameId) setLoading(false);
    }
  }, [applySnapshot, gameId]);

  const loadMessages = useCallback(async () => {
    const requestedGameId = gameId;
    const generation = requestGenerationRef.current;
    const controller = new AbortController();
    loadAbortControllersRef.current.add(controller);
    try {
      const response = await scorekeeperApi.gameMessages(requestedGameId, controller.signal);
      if (
        controller.signal.aborted ||
        deletedRef.current ||
        requestGenerationRef.current !== generation ||
        activeGameIdRef.current !== requestedGameId
      ) return;
      setMessages((current) => {
        const known = new Set(response.messages.map(({ id }) => id));
        return [...response.messages, ...current.filter(({ id }) => !known.has(id))].slice(-50);
      });
    } catch {
      // Snapshot availability is more important than the temporary, current-game message list.
    } finally {
      loadAbortControllersRef.current.delete(controller);
    }
  }, [gameId]);

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

  const exitDeletedGame = useCallback(() => {
    if (deletedRef.current) return;
    deletedRef.current = true;
    requestGenerationRef.current += 1;
    abortPageRequests();
    stopFallback();
    snapshotRef.current = null;
    setSnapshot(null);
    setLoading(false);
    setLoadError(null);
    setTab('table');
    setMessages([]);
    setSpeechOpen(false);
    setBuyOpen(false);
    setAdjustment(null);
    setEndOpen(false);
    setEnding(false);
    setEndError(null);
    navigate('/', { replace: true, state: { notice: GAME_DELETED_NOTICE } });
  }, [abortPageRequests, navigate, stopFallback]);

  const receiveDeletedGame = useCallback((value: unknown) => {
    const parsed = gameDeletedEventSchema.safeParse(value);
    if (!parsed.success || parsed.data.gameId !== activeGameIdRef.current) return;
    exitDeletedGame();
  }, [exitDeletedGame]);

  const ensureFallbackGrace = useCallback(() => {
    if (fallbackTimeoutRef.current !== undefined || pollingIntervalRef.current !== undefined) return;
    startFallbackGrace();
  }, [startFallbackGrace]);

  useEffect(() => {
    abortPageRequests();
    writeAbortRef.current = new AbortController();
    requestGenerationRef.current += 1;
    deletedRef.current = false;
    snapshotRef.current = null;
    setSnapshot(null);
    setLoading(true);
    setLoadError(null);
    setTab('table');
    setMessages([]);
    setSpeechOpen(false);
    setBuyOpen(false);
    setAdjustment(null);
    setEndOpen(false);
    if (gameId === '') {
      setLoadError('对局不存在');
      setLoading(false);
      return;
    }
    void loadSnapshot();
    void loadMessages();
    const generation = requestGenerationRef.current;
    return () => {
      if (requestGenerationRef.current === generation) requestGenerationRef.current += 1;
      abortPageRequests();
    };
  }, [abortPageRequests, gameId, loadMessages, loadSnapshot]);

  useEffect(() => {
    if (snapshot !== null && snapshot.status !== 'ACTIVE') {
      setBuyOpen(false);
      setAdjustment(null);
      setEndOpen(false);
      setSpeechOpen(false);
      setMessages([]);
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
        if (!acknowledgement.success) {
          failJoin(attempt);
          return;
        }
        if (!acknowledgement.data.ok) {
          if (acknowledgement.data.code === 'NOT_FOUND') {
            exitDeletedGame();
            return;
          }
          failJoin(attempt);
          return;
        }
        if (acknowledgement.data.gameId !== gameId) {
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
    const receiveMessage = (value: unknown) => {
      const parsed = gameMessageCreatedEventSchema.safeParse(value);
      if (!parsed.success || parsed.data.gameId !== gameId) return;
      appendMessage(parsed.data);
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
      const parsed = serverErrorEventSchema.safeParse(value);
      if (!parsed.success) return;
      if (parsed.data.code === 'NOT_FOUND') {
        exitDeletedGame();
        return;
      }
      failCurrentJoin();
    };

    const listeners: Array<[string, GameSocketListener]> = [
      ['connect', connect],
      ['disconnect', disconnect],
      ['connect_error', socketError],
      ['game.snapshot', receiveSnapshot],
      ['game.updated', receiveGameUpdate],
      ['game.message.created', receiveMessage],
      ['game.deleted', receiveDeletedGame],
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
  }, [appendMessage, applySnapshot, ensureFallbackGrace, exitDeletedGame, gameId, hasSnapshot, loadSnapshot, receiveDeletedGame, socketFactory, startFallbackGrace, stopFallback]);

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
      pollingIntervalRef.current = window.setInterval(() => {
        void loadSnapshot(true);
        void loadMessages();
      }, 10_000);
    }, 5_000);
    return stopFallback;
  }, [fallbackGeneration, loadMessages, loadSnapshot, roomSynchronized, socketReady, stopFallback]);

  const refreshAfterWrite = () => {
    void loadSnapshot(true);
  };

  const onTabKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    let next: GameTab | null = null;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      const tabs: GameTab[] = ['table', 'purchases', 'messages'];
      const offset = event.key === 'ArrowRight' ? 1 : -1;
      next = tabs[(tabs.indexOf(tab) + offset + tabs.length) % tabs.length]!;
    } else if (event.key === 'Home') {
      next = 'table';
    } else if (event.key === 'End') {
      next = 'messages';
    }
    if (next === null) return;
    event.preventDefault();
    setTab(next);
    const target = next === 'table'
      ? tableTabRef.current
      : next === 'purchases'
        ? purchaseTabRef.current
        : messageTabRef.current;
    target?.focus();
  };

  if (loading || (snapshot !== null && snapshot.id !== gameId)) return <div className="page-status">正在摆好牌桌…</div>;
  if (snapshot === null) {
    return <section className="page-stack"><Toast tone="error" message={loadError ?? '对局不存在'} /><Link className="action-link" to="/">返回首页</Link></section>;
  }

  const selfPlayer = snapshot.players.find(({ userId }) => user?.id === userId);
  const active = snapshot.status === 'ACTIVE';
  const fullForViewer = snapshot.players.length >= 12 && selfPlayer === undefined;
  const canManage = user?.role === 'ADMIN' || user?.role === 'SUPER_ADMIN';

  const sendMessage = async (text: string) => {
    if (!active) return;
    const requestedGameId = snapshot.id;
    const generation = requestGenerationRef.current;
    const created = await scorekeeperApi.createGameMessage(
      requestedGameId,
      { text },
      writeAbortRef.current.signal
    );
    if (
      writeAbortRef.current.signal.aborted ||
      deletedRef.current ||
      requestGenerationRef.current !== generation ||
      activeGameIdRef.current !== requestedGameId ||
      snapshotRef.current?.status !== 'ACTIVE'
    ) return;
    appendMessage(created);
  };

  const beginSettlement = async () => {
    if (!active || !canManage || ending) return;
    const requestedGameId = snapshot.id;
    const generation = requestGenerationRef.current;
    const controller = new AbortController();
    endAbortRef.current?.abort();
    endAbortRef.current = controller;
    setEnding(true);
    setEndError(null);
    try {
      const next = await scorekeeperApi.beginSettlement(requestedGameId, controller.signal);
      if (controller.signal.aborted || deletedRef.current || requestGenerationRef.current !== generation || activeGameIdRef.current !== requestedGameId) return;
      if (!applySnapshot(next)) throw new Error('Invalid game snapshot');
      setEndOpen(false);
      navigate(`/games/${encodeURIComponent(requestedGameId)}/settlement`, { replace: true });
    } catch (reason) {
      if (controller.signal.aborted || deletedRef.current || requestGenerationRef.current !== generation || activeGameIdRef.current !== requestedGameId) return;
      setEndError(mutationMessage(reason, '暂时无法结束对局，请刷新后重试'));
      void loadSnapshot(true);
    } finally {
      if (endAbortRef.current === controller) endAbortRef.current = null;
      if (!deletedRef.current && requestGenerationRef.current === generation && activeGameIdRef.current === requestedGameId) setEnding(false);
    }
  };

  return (
    <section className="game-page" aria-labelledby="game-title">
      <header className="game-heading">
        <div><span className="section-kicker">实时牌桌</span><h2 id="game-title">{snapshot.name}</h2></div>
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
        >竞技区</button>
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
        <button
          ref={messageTabRef}
          id="game-tab-messages"
          role="tab"
          aria-controls="game-panel-messages"
          aria-selected={tab === 'messages'}
          tabIndex={tab === 'messages' ? 0 : -1}
          onKeyDown={onTabKeyDown}
          onClick={() => setTab('messages')}
        >消息区</button>
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
      ) : tab === 'purchases' ? (
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
      ) : (
        <div id="game-panel-messages" role="tabpanel" aria-labelledby="game-tab-messages" tabIndex={0} className="game-messages-panel">
          <GameMessagesPanel messages={messages} />
        </div>
      )}

      {active && (
        <div className="game-action-dock">
          <Button unsafe disabled={fullForViewer} onClick={() => setBuyOpen(true)}>
            {fullForViewer ? '本桌已满' : '购买筹码'}
          </Button>
          <Button variant="secondary" unsafe onClick={() => setSpeechOpen(true)}>发言</Button>
        </div>
      )}

      <GameSpeechSheet
        open={speechOpen && active}
        disabled={!active}
        onClose={() => setSpeechOpen(false)}
        onSubmit={sendMessage}
      />

      <BuyInSheet
        gameId={snapshot.id}
        handPrice={snapshot.handPrice}
        open={buyOpen}
        canWrite={active}
        signal={writeAbortRef.current.signal}
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
          signal={writeAbortRef.current.signal}
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
