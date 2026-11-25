-- 1.1.3: direction of the price-change arrows of the wishlist. "price" follows the price (green down = cheaper),
-- "rating" says better or worse (green up = cheaper, the 1.1.2 look).
ALTER TABLE app_settings ADD COLUMN trend_arrows TEXT NOT NULL DEFAULT 'price' CHECK(trend_arrows IN ('price', 'rating'));
