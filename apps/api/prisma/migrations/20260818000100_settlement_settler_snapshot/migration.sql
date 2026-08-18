ALTER TABLE `settlements`
  ADD COLUMN `settled_by_nickname_snapshot` VARCHAR(64) NULL AFTER `settled_by_id`;

UPDATE `settlements` AS `s`
JOIN `users` AS `u` ON `u`.`id` = `s`.`settled_by_id`
SET `s`.`settled_by_nickname_snapshot` = `u`.`nickname`;

ALTER TABLE `settlements`
  MODIFY `settled_by_nickname_snapshot` VARCHAR(64) NOT NULL;
