-- Editorially verified conference fee. NULL means unknown, never free.
ALTER TABLE conferences ADD COLUMN meeting_fee text
  CHECK (meeting_fee IS NULL OR (char_length(meeting_fee) BETWEEN 1 AND 200 AND btrim(meeting_fee) <> ''));
