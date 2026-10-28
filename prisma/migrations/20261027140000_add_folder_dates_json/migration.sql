-- 2026-10-27: per-(contract, folder) merchandiser entry date so Summary
-- Excel Column B can carry the date each folder started feeding this
-- Sales Contract. JSON object keyed by folder letter.
ALTER TABLE "SalesContract" ADD COLUMN "folderDatesJson" TEXT NOT NULL DEFAULT '{}';
