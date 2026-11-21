-- 0.8.2: order and hidden columns of the offers table (game page, tab Angebote), like the wishlist columns.
-- Empty means the default order and nothing hidden.
ALTER TABLE app_settings ADD COLUMN offers_columns TEXT NOT NULL DEFAULT '';
ALTER TABLE app_settings ADD COLUMN offers_hidden TEXT NOT NULL DEFAULT '';
