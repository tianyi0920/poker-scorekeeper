import type { GameSnapshotDto } from '@poker/contracts';
import type {
  AvatarKind,
  BuyinEventType,
  GameStatus
} from '../generated/prisma/client.js';

export interface SnapshotGameRecord {
  id: string;
  name: string;
  status: GameStatus;
  version: number;
  handPrice: bigint;
  rakeEnabled: boolean;
  startedAt: Date | null;
  stoppedAt: Date | null;
  players: Array<{
    id: string;
    userId: string;
    nicknameSnapshot: string;
    avatarKindSnapshot: AvatarKind;
    avatarValueSnapshot: string;
    seatNo: number;
  }>;
  buyinEvents: Array<{
    id: string;
    gamePlayerId: string;
    type: BuyinEventType;
    previousHands: number | null;
    newHands: number;
    handsDelta: number;
    createdAt: Date;
    actorUser: { nickname: string };
  }>;
}

function avatarUrl(kind: AvatarKind, value: string): string {
  return kind === 'PRESET'
    ? `/avatars/${value}.webp`
    : `/avatars/uploads/${value}`;
}

export function mapGameSnapshot(
  game: SnapshotGameRecord,
  serverNow = new Date()
): GameSnapshotDto {
  const orderedEvents = [...game.buyinEvents].sort((left, right) =>
    left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id)
  );
  const handsByPlayer = new Map<string, number>();
  for (const event of orderedEvents) {
    handsByPlayer.set(
      event.gamePlayerId,
      (handsByPlayer.get(event.gamePlayerId) ?? 0) + event.handsDelta
    );
  }
  const players = [...game.players]
    .sort((left, right) => left.seatNo - right.seatNo || left.id.localeCompare(right.id))
    .map((player) => {
      const effectiveHands = handsByPlayer.get(player.id) ?? 0;
      return {
        id: player.id,
        userId: player.userId,
        nickname: player.nicknameSnapshot,
        avatarUrl: avatarUrl(player.avatarKindSnapshot, player.avatarValueSnapshot),
        seatNo: player.seatNo,
        effectiveHands,
        buyInAmount: (game.handPrice * BigInt(effectiveHands)).toString()
      };
    });

  return {
    id: game.id,
    name: game.name,
    status: game.status,
    version: game.version,
    handPrice: game.handPrice.toString(),
    rakeEnabled: game.rakeEnabled,
    startedAt: game.startedAt?.toISOString() ?? null,
    stoppedAt: game.stoppedAt?.toISOString() ?? null,
    serverNow: serverNow.toISOString(),
    players,
    purchases: orderedEvents.map((event) => ({
      id: event.id,
      playerId: event.gamePlayerId,
      actorNickname: event.actorUser.nickname,
      type: event.type,
      previousHands: event.previousHands,
      newHands: event.newHands,
      handsDelta: event.handsDelta,
      createdAt: event.createdAt.toISOString()
    })),
    spectators: []
  };
}
