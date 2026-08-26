import type { GameMessageDto, GameSpectatorSnapshotDto } from '@poker/contracts';
import { UserAvatar } from '../../components/UserAvatar.js';

export function SpectatorBar({
  spectators,
  latestMessage,
  fallbackMessage
}: {
  spectators: GameSpectatorSnapshotDto[];
  latestMessage?: GameMessageDto;
  fallbackMessage?: GameMessageDto;
}) {
  return (
    <section className="spectator-bar" aria-label="观战区">
      <div className="spectator-heading"><span>观战区</span><b>{spectators.length}</b></div>
      {spectators.length === 0 && fallbackMessage === undefined ? <p>暂无在线观战</p> : (
        <div className="spectator-list">
          {fallbackMessage !== undefined && (
            <span className="spectator arena-latest-message" data-testid="arena-latest-message">
              <UserAvatar nickname={fallbackMessage.nickname} avatarUrl={fallbackMessage.avatarUrl} />
              <strong>{fallbackMessage.nickname}</strong>
              <em className="spectator-speech">{fallbackMessage.text}</em>
            </span>
          )}
          {spectators.map((spectator) => (
            <span className="spectator" key={spectator.userId}>
              <UserAvatar nickname={spectator.nickname} avatarUrl={spectator.avatarUrl} decorative />
              <span>{spectator.nickname}</span>
              {latestMessage?.userId === spectator.userId && <em className="spectator-speech">{latestMessage.text}</em>}
            </span>
          ))}
        </div>
      )}
    </section>
  );
}
