-- Buy-in events were introduced before production launch, so legacy development
-- rows do not contain their original response version. Backfill those rows with
-- the owning game's current version before making the new column required.
ALTER TABLE `buyin_events`
  ADD COLUMN `game_version` INTEGER NULL AFTER `hands_delta`;

UPDATE `buyin_events` AS event
INNER JOIN `games` AS game ON game.id = event.game_id
SET event.game_version = game.version
WHERE event.game_version IS NULL;

ALTER TABLE `buyin_events`
  MODIFY COLUMN `game_version` INTEGER NOT NULL,
  MODIFY COLUMN `idempotency_key` VARCHAR(128)
    CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL;
