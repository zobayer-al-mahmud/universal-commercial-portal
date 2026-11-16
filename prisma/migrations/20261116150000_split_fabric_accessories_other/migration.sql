-- UD Automation: split the combined "fabric-accessories" step into three separate
-- steps — "fabric" (10), "accessories" (11), "other-material" (12) — and renumber
-- consumption (13) and documents (14). Data only; no schema change.

-- 1) Move field values to their own step (by the group's old itemType) and
--    renumber groups per new step so each step starts at row 0.
UPDATE "UdFieldValue"
SET "stepKey" = m."newStep", "groupIndex" = m."newGroup"
FROM (
  SELECT t."id", t."newStep",
         (DENSE_RANK() OVER (PARTITION BY t."recordId", t."newStep" ORDER BY t."groupIndex")) - 1 AS "newGroup"
  FROM (
    SELECT f."id", f."recordId", f."groupIndex",
      CASE
        WHEN lower(coalesce((SELECT it."value" FROM "UdFieldValue" it
                             WHERE it."recordId" = f."recordId" AND it."stepKey" = 'fabric-accessories'
                               AND it."fieldKey" = 'itemType' AND it."groupIndex" = f."groupIndex"), '')) LIKE 'accessor%' THEN 'accessories'
        WHEN lower(coalesce((SELECT it."value" FROM "UdFieldValue" it
                             WHERE it."recordId" = f."recordId" AND it."stepKey" = 'fabric-accessories'
                               AND it."fieldKey" = 'itemType' AND it."groupIndex" = f."groupIndex"), '')) LIKE 'other%' THEN 'other-material'
        ELSE 'fabric'
      END AS "newStep"
    FROM "UdFieldValue" f
    WHERE f."stepKey" = 'fabric-accessories'
  ) t
) m
WHERE "UdFieldValue"."id" = m."id";

-- The step itself now carries the type; the old itemType column is gone.
DELETE FROM "UdFieldValue" WHERE "fieldKey" = 'itemType' AND "stepKey" IN ('fabric', 'accessories', 'other-material');

-- 2) Step rows: renumber, add the three new steps, drop the combined one.
UPDATE "UdStep" SET "stepNo" = 13 WHERE "stepKey" = 'consumption';
UPDATE "UdStep" SET "stepNo" = 14 WHERE "stepKey" = 'documents';

INSERT INTO "UdStep" ("id", "recordId", "stepKey", "stepNo", "status", "entryMode", "message", "updatedBy", "createdAt", "updatedAt")
SELECT 'mig' || lower(hex(randomblob(10))), r."id", s."key", s."no",
       CASE WHEN EXISTS (SELECT 1 FROM "UdFieldValue" v WHERE v."recordId" = r."id" AND v."stepKey" = s."key" AND v."value" <> '') THEN 'in_progress' ELSE 'pending' END,
       '', '', 'migration', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "UdRecord" r
CROSS JOIN (SELECT 'fabric' AS "key", 10 AS "no" UNION ALL SELECT 'accessories', 11 UNION ALL SELECT 'other-material', 12) s
WHERE EXISTS (SELECT 1 FROM "UdStep" x WHERE x."recordId" = r."id")
  AND NOT EXISTS (SELECT 1 FROM "UdStep" y WHERE y."recordId" = r."id" AND y."stepKey" = s."key");

DELETE FROM "UdStep" WHERE "stepKey" = 'fabric-accessories';

-- 3) Records pointing past step 10 shift by the two inserted steps.
UPDATE "UdRecord" SET "currentStep" = "currentStep" + 2 WHERE "currentStep" >= 11;

-- 4) Unreviewed previews built for the old combined step are superseded (re-fetch to review).
UPDATE "UdImportBatch" SET "status" = 'superseded' WHERE "status" = 'preview' AND "previewJson" LIKE '%"fabric-accessories"%';
