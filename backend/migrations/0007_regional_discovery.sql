ALTER TABLE offer_link ADD COLUMN auto_discovered INTEGER NOT NULL DEFAULT 0 CHECK(auto_discovered IN (0,1));
ALTER TABLE shop_job ADD COLUMN search_page INTEGER NOT NULL DEFAULT 1;
-- Revisit existing wishes once so upgrades discover every regional variant too.
UPDATE shop_job SET due=0,checked_at=NULL,last_error=NULL,result_count=0,
    lease_until=0,lease_token=NULL,failures=0 WHERE wish_id IS NOT NULL;
