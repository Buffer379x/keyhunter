-- 0.9.3 (SCORE-03 / RESP-19): the offers column "score" is shown as "Prüftempo" and hidden by default. An owner who never
-- hid a column gets the new default; anyone who chose hidden columns keeps exactly that choice. The key stays "score".
UPDATE app_settings SET offers_hidden = 'score' WHERE offers_hidden = '';
