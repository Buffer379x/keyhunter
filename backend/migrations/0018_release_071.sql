-- Release 0.7.1: wishlist table options in the settings.
-- Hidden columns, comma separated (keys of the column order); empty = every column shown.
ALTER TABLE app_settings ADD COLUMN wishlist_hidden TEXT NOT NULL DEFAULT '';
-- What opens the game page from the list: the details button, the title or the cover (only one of them).
ALTER TABLE app_settings ADD COLUMN wishlist_open TEXT NOT NULL DEFAULT 'button' CHECK(wishlist_open IN ('button', 'title', 'cover'));
