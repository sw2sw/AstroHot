-- Every notice keeps what it stated, so a field can be withdrawn with the notice that supported it.
--
-- Before this column the conference row held the union of its notices: if a notice that supplied the
-- venue was withdrawn, the venue stayed on the row and kept being shown as long as any other notice
-- remained public. A field now lives exactly as long as a notice that states it still stands.
--
-- Rollback (see deployment-plan.md §2): additive. Reverting the code leaves the column unread; the old
-- projection keeps working on the same rows.
ALTER TABLE conference_notices ADD COLUMN payload jsonb NOT NULL DEFAULT '{}'::jsonb;

-- One-off backfill for rows written before this migration: the conference row was their union, so it is
-- the closest available statement of what each notice supported. A later revision of the article
-- rewrites the true payload, and a retraction recomputes the row from the notices that remain.
UPDATE conference_notices n
   SET payload = jsonb_strip_nulls(jsonb_build_object(
         'name', c.name,
         'edition', c.edition,
         'startDate', c.start_date,
         'endDate', c.end_date,
         'timezone', c.timezone,
         'city', c.city,
         'venue', c.venue,
         'online', c.online,
         'organizer', c.organizer,
         'officialUrl', c.official_url,
         'registrationUrl', c.registration_url,
         'deadlines', n.deadlines
       ))
  FROM conferences c
 WHERE c.id = n.conference_id
   AND n.payload = '{}'::jsonb;
