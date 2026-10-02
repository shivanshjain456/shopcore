-- Feature #15 — Hero Banner CMS

CREATE TABLE "HeroBanner" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "headline" TEXT NOT NULL,
    "subheadline" TEXT,
    "ctaLabel" TEXT,
    "ctaHref" TEXT,
    "imageDesktopUrl" TEXT NOT NULL,
    "imageMobileUrl" TEXT,
    "imageAlt" TEXT,
    "textColor" TEXT,
    "overlayOpacity" INTEGER NOT NULL DEFAULT 35,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "startsAt" DATETIME,
    "endsAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "createdById" TEXT,
    "updatedById" TEXT
);
CREATE INDEX "HeroBanner_isActive_displayOrder_idx" ON "HeroBanner"("isActive", "displayOrder");
CREATE INDEX "HeroBanner_startsAt_endsAt_idx"       ON "HeroBanner"("startsAt", "endsAt");
