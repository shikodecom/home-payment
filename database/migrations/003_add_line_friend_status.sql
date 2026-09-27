-- 既存のusersテーブルへLINE公式アカウントの友だち状態を追加します。
-- すでに追加済みの場合も安全に再実行できます。
SET @line_friend_column_exists = (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'users'
    AND COLUMN_NAME = 'line_friend_added'
);
SET @line_friend_column_sql = IF(
  @line_friend_column_exists = 0,
  'ALTER TABLE users ADD COLUMN line_friend_added TINYINT(1) NULL AFTER profile_image_url',
  'SELECT 1'
);
PREPARE line_friend_column_statement FROM @line_friend_column_sql;
EXECUTE line_friend_column_statement;
DEALLOCATE PREPARE line_friend_column_statement;
