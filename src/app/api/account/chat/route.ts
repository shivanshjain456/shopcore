/**
 * Lightweight live chat — long-poll (no third-party WebSocket service).
 *
 * GET  /api/account/chat?since=<msgId>   → returns new messages since that id, polling up to ~25s.
 * POST /api/account/chat  body={ body }  → posts a customer message; bumps room to OPEN.
 *
 * Suitable for our scale (1 admin, <100 concurrent customers). For higher scale,
 * swap with SSE or a managed channel without changing the API shape.
 */
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { jsonError, jsonOk, withErrorHandling } from '@/lib/api';
import { assertCsrf } from '@/lib/security/csrf';
import { getCurrentUser } from '@/lib/auth/session';
import { requireLiveChatEnabled } from '@/lib/storeConfig/featureGate';
import { prisma } from '@/lib/db/client';

export const dynamic = 'force-dynamic';

async function ensureRoom(userId: string) {
  const existing = await prisma.chatRoom.findUnique({ where: { userId } });
  if (existing) return existing;
  return prisma.chatRoom.create({ data: { userId, status: 'OPEN' } });
}

export const GET = withErrorHandling(async (req: NextRequest) => {
  await requireLiveChatEnabled();
  const user = await getCurrentUser();
  if (!user) return jsonError('Please sign in.', 401);
  const room = await ensureRoom(user.id);
  const since = req.nextUrl.searchParams.get('since');
  const wait  = Math.min(25, Math.max(0, Number(req.nextUrl.searchParams.get('wait') ?? '0')));

  const fetchNew = async () => {
    const where = since
      ? { roomId: room.id, id: { gt: since } }
      : { roomId: room.id };
    return prisma.chatMessage.findMany({ where, orderBy: { createdAt: 'asc' }, take: 200 });
  };

  const start = Date.now();
  let msgs = await fetchNew();
  // Poll loop — cheap for SQLite at our scale.
  while (msgs.length === 0 && wait > 0 && (Date.now() - start) < wait * 1000) {
    await new Promise((r) => setTimeout(r, 1500));
    msgs = await fetchNew();
  }

  return jsonOk({
    roomId: room.id,
    status: room.status,
    messages: msgs.map((m) => ({
      id: m.id, body: m.body, fromId: m.fromId, isOwn: m.fromId === user.id, createdAt: m.createdAt,
    })),
  });
});

const Body = z.object({ body: z.string().trim().min(1).max(2000) });

export const POST = withErrorHandling(async (req: NextRequest) => {
  assertCsrf();
  await requireLiveChatEnabled();
  const user = await getCurrentUser();
  if (!user) return jsonError('Please sign in.', 401);
  const { body } = Body.parse(await req.json());
  const room = await ensureRoom(user.id);
  const msg = await prisma.chatMessage.create({
    data: { roomId: room.id, fromId: user.id, body },
  });
  if (room.status !== 'OPEN') {
    await prisma.chatRoom.update({ where: { id: room.id }, data: { status: 'OPEN' } });
  }
  return jsonOk({ id: msg.id, createdAt: msg.createdAt });
});
