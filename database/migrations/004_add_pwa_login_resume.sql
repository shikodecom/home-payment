-- iPhoneのホーム画面(PWA)とSafariの間でLINEログイン完了を安全に引き継ぎます。
-- 認証情報そのものではなく、15分・一回限りの復帰キーのハッシュだけを保存します。
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
