-- Script para adicionar controle de orientacao na tabela displays.
-- Execute no Supabase SQL Editor.
--
-- Valores aceitos pelo player:
-- - auto: usa a orientacao fisica detectada
-- - vertical ou portrait: forca exibicao vertical
-- - horizontal ou landscape: forca exibicao horizontal

ALTER TABLE displays
ADD COLUMN IF NOT EXISTS orientacao TEXT DEFAULT 'auto';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'displays_orientacao_check'
  ) THEN
    ALTER TABLE displays
    ADD CONSTRAINT displays_orientacao_check
    CHECK (
      orientacao IS NULL OR
      lower(orientacao) IN ('auto', 'vertical', 'horizontal', 'portrait', 'landscape', 'retrato', 'paisagem')
    )
    NOT VALID;
  END IF;
END $$;

COMMENT ON COLUMN displays.orientacao IS 'Orientacao desejada do player: auto, vertical/portrait ou horizontal/landscape';

SELECT
  column_name,
  data_type,
  column_default,
  is_nullable
FROM information_schema.columns
WHERE table_name = 'displays'
  AND column_name = 'orientacao';
