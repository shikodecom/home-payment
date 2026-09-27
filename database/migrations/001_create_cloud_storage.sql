-- 家計の支払めも: 初期クラウド保存スキーマ
-- MySQL 5.7 / 8.0互換を優先し、既存テーブルを削除しません。
SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS users (
  id CHAR(36) NOT NULL,
  display_name VARCHAR(255) NOT NULL,
  profile_image_url VARCHAR(2048) NULL,
  line_friend_added TINYINT(1) NULL,
  created_at DATETIME(6) NOT NULL,
  updated_at DATETIME(6) NOT NULL,
  last_login_at DATETIME(6) NOT NULL,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS auth_identities (
  id CHAR(36) NOT NULL,
  user_id CHAR(36) NOT NULL,
  provider VARCHAR(32) NOT NULL,
  provider_user_id VARCHAR(255) NOT NULL,
  provider_display_name VARCHAR(255) NULL,
  provider_profile_image_url VARCHAR(2048) NULL,
  created_at DATETIME(6) NOT NULL,
  updated_at DATETIME(6) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_auth_provider_user (provider, provider_user_id),
  KEY idx_auth_identity_user (user_id),
  CONSTRAINT fk_auth_identity_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS user_sessions (
  id CHAR(36) NOT NULL,
  user_id CHAR(36) NOT NULL,
  token_hash CHAR(64) NOT NULL,
  csrf_token_hash CHAR(64) NOT NULL,
  created_at DATETIME(6) NOT NULL,
  expires_at DATETIME(6) NOT NULL,
  last_used_at DATETIME(6) NOT NULL,
  revoked_at DATETIME(6) NULL,
  user_agent VARCHAR(512) NULL,
  ip_address VARCHAR(45) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_session_token_hash (token_hash),
  KEY idx_session_user_active (user_id, revoked_at, expires_at),
  CONSTRAINT fk_session_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS auth_login_attempts (
  id CHAR(36) NOT NULL,
  state_hash CHAR(64) NOT NULL,
  nonce_value VARCHAR(128) NOT NULL,
  code_verifier VARCHAR(128) NOT NULL,
  return_url VARCHAR(2048) NOT NULL,
  created_at DATETIME(6) NOT NULL,
  expires_at DATETIME(6) NOT NULL,
  used_at DATETIME(6) NULL,
  ip_address VARCHAR(45) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_login_state_hash (state_hash),
  KEY idx_login_attempt_expiry (expires_at, used_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS auth_login_resumes (
  token_hash CHAR(64) NOT NULL,
  login_attempt_id CHAR(36) NOT NULL,
  user_id CHAR(36) NULL,
  created_at DATETIME(6) NOT NULL,
  expires_at DATETIME(6) NOT NULL,
  completed_at DATETIME(6) NULL,
  consumed_at DATETIME(6) NULL,
  PRIMARY KEY (token_hash),
  UNIQUE KEY uq_login_resume_attempt (login_attempt_id),
  KEY idx_login_resume_expiry (expires_at, consumed_at),
  KEY idx_login_resume_user (user_id),
  CONSTRAINT fk_login_resume_attempt FOREIGN KEY (login_attempt_id) REFERENCES auth_login_attempts(id) ON DELETE CASCADE,
  CONSTRAINT fk_login_resume_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS payments (
  id CHAR(36) NOT NULL,
  user_id CHAR(36) NOT NULL,
  client_id CHAR(36) NOT NULL,
  amount BIGINT NOT NULL,
  memo VARCHAR(2000) NOT NULL DEFAULT '',
  billing_target_type ENUM('household','self','other','unset') NOT NULL,
  billing_target_name VARCHAR(255) NULL,
  group_name VARCHAR(255) NOT NULL,
  paid_at DATETIME(6) NOT NULL,
  created_at DATETIME(6) NOT NULL,
  updated_at DATETIME(6) NOT NULL,
  processed_at DATETIME(6) NULL,
  archive_batch_id CHAR(36) NULL,
  deleted_at DATETIME(6) NULL,
  version INT UNSIGNED NOT NULL DEFAULT 1,
  is_one_off TINYINT(1) NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  UNIQUE KEY uq_payment_user_client (user_id, client_id),
  KEY idx_payment_user_timeline (user_id, deleted_at, paid_at),
  KEY idx_payment_user_pending (user_id, processed_at, billing_target_type, group_name),
  KEY idx_payment_archive (archive_batch_id),
  CONSTRAINT fk_payment_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS archive_batches (
  id CHAR(36) NOT NULL,
  user_id CHAR(36) NOT NULL,
  group_name VARCHAR(255) NOT NULL,
  billing_target_type ENUM('household','other','unset') NOT NULL,
  billing_target_name VARCHAR(255) NULL,
  total_amount BIGINT NOT NULL,
  item_count INT UNSIGNED NOT NULL,
  processed_at DATETIME(6) NOT NULL,
  created_at DATETIME(6) NOT NULL,
  restored_at DATETIME(6) NULL,
  PRIMARY KEY (id),
  KEY idx_archive_user_processed (user_id, restored_at, processed_at),
  CONSTRAINT fk_archive_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE payments
  ADD CONSTRAINT fk_payment_archive
  FOREIGN KEY (archive_batch_id) REFERENCES archive_batches(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS archive_batch_payments (
  archive_batch_id CHAR(36) NOT NULL,
  payment_id CHAR(36) NOT NULL,
  user_id CHAR(36) NOT NULL,
  PRIMARY KEY (archive_batch_id, payment_id),
  KEY idx_archive_payment_user (user_id),
  KEY idx_archive_payment_payment (payment_id),
  CONSTRAINT fk_abp_archive FOREIGN KEY (archive_batch_id) REFERENCES archive_batches(id) ON DELETE CASCADE,
  CONSTRAINT fk_abp_payment FOREIGN KEY (payment_id) REFERENCES payments(id) ON DELETE CASCADE,
  CONSTRAINT fk_abp_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS user_settings (
  user_id CHAR(36) NOT NULL,
  current_group_name VARCHAR(255) NOT NULL DEFAULT '日常生活',
  default_billing_target_type ENUM('household','self','other','unset') NOT NULL DEFAULT 'household',
  default_billing_target_name VARCHAR(255) NULL,
  created_at DATETIME(6) NOT NULL,
  updated_at DATETIME(6) NOT NULL,
  PRIMARY KEY (user_id),
  CONSTRAINT fk_settings_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS api_rate_limits (
  rate_key CHAR(64) NOT NULL,
  window_started_at DATETIME NOT NULL,
  request_count INT UNSIGNED NOT NULL DEFAULT 0,
  expires_at DATETIME NOT NULL,
  PRIMARY KEY (rate_key),
  KEY idx_rate_expiry (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
