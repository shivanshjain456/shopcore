import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { jsonError, jsonOk, withErrorHandling } from '@/lib/api';
import { assertCsrf } from '@/lib/security/csrf';
import { requireAdminUser, AdminGuardError, audit } from '@/lib/admin/guards';
import { prisma } from '@/lib/db/client';
import { sendGenericEmail } from '@/lib/email/send';
import { parsePaginationParams, buildPagination } from '@/lib/pagination';
import { getStoreConfig } from '@/lib/storeConfig';

export const dynamic = 'force-dynamic';

export const GET = withErrorHandling(async (req: NextRequest) => {
  await requireAdminUser();
  const config = await getStoreConfig();
  const { page, pageSize, skip, take } = parsePaginationParams(
    req.nextUrl.searchParams, config, { defaultPageSize: 20 },
  );
  const [total, items] = await Promise.all([
    prisma.emailCampaign.count(),
    prisma.emailCampaign.findMany({ orderBy: { createdAt: 'desc' }, skip, take }),
  ]);
  return jsonOk(buildPagination(items, total, page, pageSize));
});

const Body = z.object({
  subject: z.string().trim().min(1).max(200),
  bodyHtml: z.string().min(1).max(200_000),
  audience: z.enum(['ALL', 'B2C', 'B2B']),
  sendNow: z.boolean().default(false),
});

async function recipientsFor(audience: 'ALL' | 'B2C' | 'B2B'): Promise<string[]> {
  const where = audience === 'ALL' ? { status: 'ACTIVE' }
              : audience === 'B2C' ? { status: 'ACTIVE', role: 'CUSTOMER' }
              : { status: 'ACTIVE', role: 'B2B', b2bApprovedAt: { not: null } };
  // PAGINATION-EXEMPT: campaign send fan-out — the daily email cap
  //   in getStoreConfig().notifications.dailyEmailCap is the real safety
  //   bound; the SEND_EMAIL job enforces it row-by-row.
  const users = await prisma.user.findMany({ where, select: { email: true } });
  return users.map((u) => u.email);
}

export const POST = withErrorHandling(async (req: NextRequest) => {
  assertCsrf();
  const admin = await requireAdminUser();
  const body = Body.parse(await req.json());

  const rcps = await recipientsFor(body.audience);
  const campaign = await prisma.emailCampaign.create({
    data: {
      subject: body.subject, bodyHtml: body.bodyHtml, audience: body.audience,
      recipientCount: rcps.length,
    },
  });

  let sent = 0; const errors: string[] = [];
  if (body.sendNow) {
    // Sequential, capped at 500 per request (fits free SMTP daily limits).
    for (const to of rcps.slice(0, 500)) {
      try { await sendGenericEmail(to, body.subject, body.bodyHtml); sent++; }
      catch (e) { errors.push(`${to}: ${(e as Error).message}`); if (errors.length >= 5) break; }
    }
    await prisma.emailCampaign.update({ where: { id: campaign.id }, data: { sentAt: new Date() } });
  }
  await audit({ actorId: admin.id, action: 'CAMPAIGN_CREATE', entity: 'EmailCampaign', entityId: campaign.id, after: { ...body, sentCount: sent, recipientCount: rcps.length } });
  return jsonOk({ campaign, sent, recipients: rcps.length, errorsSample: errors });
});
