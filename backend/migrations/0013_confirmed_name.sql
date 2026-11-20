-- Shop title at confirmation, so a later rename is shown as a review hint (audit DQ-05).
ALTER TABLE offer_link ADD COLUMN confirmed_name TEXT;
UPDATE offer_link SET confirmed_name = json_extract(latest, '$.name') WHERE review = 'confirmed' AND json_valid(latest);
