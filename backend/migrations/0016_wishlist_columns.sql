-- Order of the wishlist table columns chosen in the settings, comma separated (release 0.6.5).
-- Empty means the default order.
ALTER TABLE app_settings ADD COLUMN wishlist_columns TEXT NOT NULL DEFAULT '';
