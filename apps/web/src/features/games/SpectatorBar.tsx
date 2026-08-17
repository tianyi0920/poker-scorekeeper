import type { GameSpectatorSnapshotDto } from '@poker/contracts';

export function SpectatorBar({ spectators }: { spectators: GameSpectatorSnapshotDto[] }) {
  return (
    <section className="spectator-bar" aria-label="观战区">
      <div className="spectator-heading"><span>观战区</span><b>{spectators.length}</b></div>
      {spectators.length === 0 ? <p>暂无在线观战</p> : (
        <div className="spectator-list">
          {spectators.map((spectator) => (
            <span className="spectator" key={spectator.userId}>
              <img src={spectator.avatarUrl} alt="" />
              <span>{spectator.nickname}</span>
            </span>
          ))}
        </div>
      )}
    </section>
  );
}
