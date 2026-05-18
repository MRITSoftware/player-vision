-- ============================================================
-- MRIT Vision — OTA setup pós-restore
-- Execute no Supabase SQL Editor
-- ============================================================

-- Tabela de versões do player (OTA)
CREATE TABLE IF NOT EXISTS app_versions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  version          TEXT NOT NULL,
  bundle_url       TEXT NOT NULL,
  target_device_id TEXT,   -- NULL = todos os dispositivos
  target_codigo    TEXT,   -- NULL = todos os códigos de display
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE app_versions ENABLE ROW LEVEL SECURITY;
CREATE POLICY app_versions_anon_read ON app_versions
  FOR SELECT TO anon USING (true);


-- ============================================================
-- Storage bucket para o player.js do OTA:
--   Dashboard → Storage → New bucket
--   Nome: app-updates   (ou o que preferir — ajuste bundle_url na hora de inserir)
--   Public: sim
-- ============================================================
