ALTER TABLE `settlements`
  ADD COLUMN `settled_by_nickname_snapshot` VARCHAR(64) NULL AFTER `settled_by_id`;

ALTER TABLE `settlements`
  MODIFY `settled_by_nickname_snapshot` VARCHAR(64) NOT NULL;
