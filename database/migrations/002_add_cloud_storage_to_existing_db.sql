-- 既存DBへクラウド保存機能を追加するマイグレーション
-- 現在のアプリはMySQLテーブルを持たないため、001と同じCREATE TABLE IF NOT EXISTSを実行します。
-- データ削除を伴うDROP/TRUNCATEは含みません。
SOURCE 001_create_cloud_storage.sql;
