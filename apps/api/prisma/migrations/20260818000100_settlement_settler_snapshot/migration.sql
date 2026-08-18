DROP TEMPORARY TABLE IF EXISTS `_migration_guard_settler_snapshot`;

CREATE TEMPORARY TABLE `_migration_guard_settler_snapshot` (
  `id` TINYINT NOT NULL PRIMARY KEY
) ENGINE = MEMORY;

INSERT INTO `_migration_guard_settler_snapshot` (`id`) VALUES (1);

INSERT INTO `_migration_guard_settler_snapshot` (`id`)
SELECT 1 FROM `settlements` LIMIT 1;

DROP TEMPORARY TABLE `_migration_guard_settler_snapshot`;

ALTER TABLE `settlements`
  ADD COLUMN `settled_by_nickname_snapshot` VARCHAR(64) NULL AFTER `settled_by_id`;

ALTER TABLE `settlements`
  MODIFY `settled_by_nickname_snapshot` VARCHAR(64) NOT NULL;
