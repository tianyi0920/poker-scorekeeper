-- CreateTable
CREATE TABLE `users` (
    `id` VARCHAR(30) NOT NULL,
    `username` VARCHAR(64) NOT NULL,
    `normalized_username` VARCHAR(64) NOT NULL,
    `nickname` VARCHAR(64) NOT NULL,
    `active_normalized_nickname` VARCHAR(64) NULL,
    `password_hash` VARCHAR(255) NOT NULL,
    `role` ENUM('SUPER_ADMIN', 'ADMIN', 'USER') NOT NULL DEFAULT 'USER',
    `rake_enabled` BOOLEAN NOT NULL DEFAULT true,
    `avatar_kind` ENUM('PRESET', 'UPLOAD') NOT NULL DEFAULT 'PRESET',
    `avatar_value` VARCHAR(512) NOT NULL,
    `is_active` BOOLEAN NOT NULL DEFAULT true,
    `must_change_password` BOOLEAN NOT NULL DEFAULT false,
    `created_by_id` VARCHAR(30) NULL,
    `deleted_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `users_normalized_username_key`(`normalized_username`),
    UNIQUE INDEX `users_active_normalized_nickname_key`(`active_normalized_nickname`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `auth_sessions` (
    `id` VARCHAR(30) NOT NULL,
    `user_id` VARCHAR(30) NOT NULL,
    `token_hash` VARCHAR(128) NOT NULL,
    `expires_at` DATETIME(3) NOT NULL,
    `absolute_expires_at` DATETIME(3) NOT NULL,
    `last_seen_at` DATETIME(3) NOT NULL,
    `ip_address` VARCHAR(45) NOT NULL,
    `user_agent` VARCHAR(512) NOT NULL,
    `revoked_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `auth_sessions_token_hash_key`(`token_hash`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `system_settings` (
    `id` VARCHAR(30) NOT NULL DEFAULT 'singleton',
    `rake_threshold` BIGINT NOT NULL DEFAULT 1000,
    `rake_bps` INTEGER NOT NULL DEFAULT 1000,
    `version` INTEGER NOT NULL DEFAULT 1,
    `updated_by_id` VARCHAR(30) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `games` (
    `id` VARCHAR(30) NOT NULL,
    `name` VARCHAR(128) NOT NULL,
    `hand_price` BIGINT NOT NULL,
    `rake_enabled` BOOLEAN NOT NULL DEFAULT true,
    `status` ENUM('DRAFT', 'ACTIVE', 'SETTLING', 'COMPLETED', 'VOIDED') NOT NULL DEFAULT 'DRAFT',
    `version` INTEGER NOT NULL DEFAULT 1,
    `created_by_id` VARCHAR(30) NOT NULL,
    `started_at` DATETIME(3) NULL,
    `stopped_at` DATETIME(3) NULL,
    `completed_at` DATETIME(3) NULL,
    `settled_by_id` VARCHAR(30) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `games_status_started_at_idx`(`status`, `started_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `game_players` (
    `id` VARCHAR(30) NOT NULL,
    `game_id` VARCHAR(30) NOT NULL,
    `user_id` VARCHAR(30) NOT NULL,
    `nickname_snapshot` VARCHAR(64) NOT NULL,
    `avatar_kind_snapshot` ENUM('PRESET', 'UPLOAD') NOT NULL,
    `avatar_value_snapshot` VARCHAR(512) NOT NULL,
    `seat_no` INTEGER NOT NULL,
    `first_buyin_at` DATETIME(3) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `game_players_game_id_user_id_key`(`game_id`, `user_id`),
    UNIQUE INDEX `game_players_game_id_seat_no_key`(`game_id`, `seat_no`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `active_player_locks` (
    `user_id` VARCHAR(30) NOT NULL,
    `game_id` VARCHAR(30) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`user_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `buyin_events` (
    `id` VARCHAR(30) NOT NULL,
    `game_id` VARCHAR(30) NOT NULL,
    `game_player_id` VARCHAR(30) NOT NULL,
    `actor_user_id` VARCHAR(30) NOT NULL,
    `type` ENUM('BUY', 'ADJUST') NOT NULL,
    `logical_buy_id` VARCHAR(30) NOT NULL,
    `previous_hands` INTEGER NULL,
    `new_hands` INTEGER NOT NULL,
    `hands_delta` INTEGER NOT NULL,
    `idempotency_key` VARCHAR(128) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `buyin_events_idempotency_key_key`(`idempotency_key`),
    INDEX `buyin_events_game_player_id_created_at_id_idx`(`game_player_id`, `created_at`, `id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `settlement_drafts` (
    `id` VARCHAR(30) NOT NULL,
    `game_id` VARCHAR(30) NOT NULL,
    `payload` JSON NOT NULL,
    `version` INTEGER NOT NULL DEFAULT 1,
    `editor_user_id` VARCHAR(30) NOT NULL,
    `lease_expires_at` DATETIME(3) NOT NULL,
    `updated_by_id` VARCHAR(30) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `settlement_drafts_game_id_key`(`game_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `settlements` (
    `id` VARCHAR(30) NOT NULL,
    `game_id` VARCHAR(30) NOT NULL,
    `buy_in_total` BIGINT NOT NULL,
    `cash_out_total` BIGINT NOT NULL,
    `room_fee` BIGINT NOT NULL,
    `other_fee` BIGINT NOT NULL,
    `other_fee_note` VARCHAR(500) NOT NULL DEFAULT '',
    `rake_threshold_used` BIGINT NOT NULL,
    `rake_bps_used` INTEGER NOT NULL,
    `settings_version_used` INTEGER NOT NULL,
    `rake_total` BIGINT NOT NULL,
    `final_total` BIGINT NOT NULL,
    `settled_by_id` VARCHAR(30) NOT NULL,
    `locked_at` DATETIME(3) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `settlements_game_id_key`(`game_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `settlement_results` (
    `id` VARCHAR(30) NOT NULL,
    `settlement_id` VARCHAR(30) NOT NULL,
    `game_player_id` VARCHAR(30) NOT NULL,
    `buy_in` BIGINT NOT NULL,
    `cash_out` BIGINT NOT NULL,
    `raw_profit` BIGINT NOT NULL,
    `room_fee_share` BIGINT NOT NULL,
    `other_fee_share` BIGINT NOT NULL,
    `after_fee_profit` BIGINT NOT NULL,
    `rake_eligible` BOOLEAN NOT NULL,
    `rake_amount` BIGINT NOT NULL,
    `final_amount` BIGINT NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `settlement_results_settlement_id_game_player_id_key`(`settlement_id`, `game_player_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `settlement_fee_allocations` (
    `id` VARCHAR(30) NOT NULL,
    `settlement_id` VARCHAR(30) NOT NULL,
    `fee_type` ENUM('ROOM', 'OTHER') NOT NULL,
    `game_player_id` VARCHAR(30) NOT NULL,
    `allocation_order` INTEGER NOT NULL,
    `amount` BIGINT NOT NULL,
    `received_remainder` BOOLEAN NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `settlement_fee_allocations_settlement_id_fee_type_game_playe_key`(`settlement_id`, `fee_type`, `game_player_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `audit_logs` (
    `id` VARCHAR(30) NOT NULL,
    `actor_user_id` VARCHAR(30) NULL,
    `action` VARCHAR(100) NOT NULL,
    `entity_type` VARCHAR(100) NOT NULL,
    `entity_id` VARCHAR(30) NOT NULL,
    `request_id` VARCHAR(128) NOT NULL,
    `before_json` JSON NULL,
    `after_json` JSON NULL,
    `source_ip` VARCHAR(45) NOT NULL,
    `user_agent` VARCHAR(512) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `audit_logs_actor_user_id_created_at_idx`(`actor_user_id`, `created_at`),
    INDEX `audit_logs_entity_type_entity_id_created_at_idx`(`entity_type`, `entity_id`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `users` ADD CONSTRAINT `users_created_by_id_fkey` FOREIGN KEY (`created_by_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `auth_sessions` ADD CONSTRAINT `auth_sessions_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `system_settings` ADD CONSTRAINT `system_settings_updated_by_id_fkey` FOREIGN KEY (`updated_by_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `games` ADD CONSTRAINT `games_created_by_id_fkey` FOREIGN KEY (`created_by_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `games` ADD CONSTRAINT `games_settled_by_id_fkey` FOREIGN KEY (`settled_by_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `game_players` ADD CONSTRAINT `game_players_game_id_fkey` FOREIGN KEY (`game_id`) REFERENCES `games`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `game_players` ADD CONSTRAINT `game_players_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `active_player_locks` ADD CONSTRAINT `active_player_locks_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `active_player_locks` ADD CONSTRAINT `active_player_locks_game_id_fkey` FOREIGN KEY (`game_id`) REFERENCES `games`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `buyin_events` ADD CONSTRAINT `buyin_events_game_id_fkey` FOREIGN KEY (`game_id`) REFERENCES `games`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `buyin_events` ADD CONSTRAINT `buyin_events_game_player_id_fkey` FOREIGN KEY (`game_player_id`) REFERENCES `game_players`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `buyin_events` ADD CONSTRAINT `buyin_events_actor_user_id_fkey` FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `settlement_drafts` ADD CONSTRAINT `settlement_drafts_game_id_fkey` FOREIGN KEY (`game_id`) REFERENCES `games`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `settlement_drafts` ADD CONSTRAINT `settlement_drafts_editor_user_id_fkey` FOREIGN KEY (`editor_user_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `settlement_drafts` ADD CONSTRAINT `settlement_drafts_updated_by_id_fkey` FOREIGN KEY (`updated_by_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `settlements` ADD CONSTRAINT `settlements_game_id_fkey` FOREIGN KEY (`game_id`) REFERENCES `games`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `settlements` ADD CONSTRAINT `settlements_settled_by_id_fkey` FOREIGN KEY (`settled_by_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `settlement_results` ADD CONSTRAINT `settlement_results_settlement_id_fkey` FOREIGN KEY (`settlement_id`) REFERENCES `settlements`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `settlement_results` ADD CONSTRAINT `settlement_results_game_player_id_fkey` FOREIGN KEY (`game_player_id`) REFERENCES `game_players`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `settlement_fee_allocations` ADD CONSTRAINT `settlement_fee_allocations_settlement_id_fkey` FOREIGN KEY (`settlement_id`) REFERENCES `settlements`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `settlement_fee_allocations` ADD CONSTRAINT `settlement_fee_allocations_game_player_id_fkey` FOREIGN KEY (`game_player_id`) REFERENCES `game_players`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `audit_logs` ADD CONSTRAINT `audit_logs_actor_user_id_fkey` FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- Seed singleton system settings
INSERT INTO system_settings
  (id, rake_threshold, rake_bps, version, created_at, updated_at)
VALUES
  ('singleton', 1000, 1000, 1, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3));
