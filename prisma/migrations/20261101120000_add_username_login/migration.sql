-- Username-based login: add a unique `username` to User (nullable so existing
-- rows can be backfilled; the login identity becomes the username while `email`
-- is retained for audit/display + backward compatibility).
ALTER TABLE "User" ADD COLUMN "username" TEXT;
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");
