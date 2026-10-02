-- Apply before deploying the API/frontend that send X-Operation-Id.
-- Retain receipts so an offline device can safely replay an old operation.
CREATE TABLE IF NOT EXISTS mutation_receipts (
  user_id CHAR(36) NOT NULL,
  operation_id CHAR(36) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  response_json MEDIUMTEXT NULL,
  http_status SMALLINT UNSIGNED NULL,
  created_at DATETIME(6) NOT NULL,
  PRIMARY KEY (user_id, operation_id),
  KEY idx_mutation_created (created_at),
  CONSTRAINT fk_mutation_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
