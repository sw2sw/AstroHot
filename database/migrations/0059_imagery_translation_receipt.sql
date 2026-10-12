-- Existing translations remain readable; new completions retain their durable paid-request provenance.
ALTER TABLE imagery_archive ADD COLUMN translation_receipt_id BIGINT REFERENCES receipts(id);
