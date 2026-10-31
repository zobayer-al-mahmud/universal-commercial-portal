-- 2026-10-26: add sourceFolderPath to the folder-mapping config so the
-- Sales Contract Creation module can scan a configured local folder (e.g.
-- D:\order\A) for .msg files instead of asking the user to pick each PDF.
ALTER TABLE "SalesContractFolderMapping" ADD COLUMN "sourceFolderPath" TEXT NOT NULL DEFAULT '';
