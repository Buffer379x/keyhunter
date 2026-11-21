-- Release 0.6.5.
-- Order of the wishlist table columns chosen in the settings, comma separated; empty means the default order.
ALTER TABLE app_settings ADD COLUMN wishlist_columns TEXT NOT NULL DEFAULT '';
-- Price trend of a shop product within its wish: 0 = mostly the cheapest, 1 = mostly the most expensive (moving average
-- of the relative price position at each measurement); 0.5 = no comparison yet.
ALTER TABLE offer_link ADD COLUMN cheap_score REAL NOT NULL DEFAULT 0.5;
-- Factor on the interval of the next product check: 0.5 (twice as often) to 2 (half as often), from the trend; sold out = 2.
-- Every region is treated alike: the old factor 3 for products not valid in the target country is gone.
ALTER TABLE shop_job ADD COLUMN pace REAL NOT NULL DEFAULT 1;
