/**
 * Admin chat inbox + per-room poller.
 *   GET                       → list rooms
 *   GET ?roomId=XXX&since=ID  → poll a room's new messages
 *   POST roomId, body         → admin reply
 */
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { jsonError, jsonOk, withErrorHandling } from '@/lib/api';
import { assertCsrf } from '@/lib/security/csrf';
import { requireAdminUser, AdminGuardError } from '@/lib/admin/guards';
import { prisma } from '@/lib/db/client';

export const dynamic = 'force-dynamic';

export const GET = withErrorHandling(async (req: NextRequest) => {
  await requireAdminUser();
  const sp = req.nextUrl.searchParams;
  const roomId = sp.get('roomId');
  if (!roomId) {
    const rooms = await prisma.chatRoom.findMany({
      orderBy: { updatedAt: 'desc' }, take: 100,
      include: {
        user: { select: { id: true, email: true, firstName: true, lastName: true } },
        messages: { orderBy: { createdAt: 'desc' }, take: 1 },
        _count: { select: { messages: true } },
      },
    });
    return jsonOk({ rooms: rooms.map((r) => ({
      id: r.id, status: r.status, updatedAt: r.updatedAt, createdAt: r.createdAt,
      user: r.user, messageCount: r._count.messages,
      lastMessage: r.messages[0] ? { body: r.messages[0].body, createdAt: r.messages[0].createdAt, fromId: r.messages[0].fromId } : null,
    })) });
  }
  const since = sp.get('since');
  const wait  = Math.min(25, Math.max(0, Number(sp.get('wait') ?? '0')));

  const fetchNew = async () => prisma.chatMessage.findMany({
    where: { roomId, ...(since ? { id: { gt: since } } : {}) },
    orderBy: { createdAt: 'asc' }, take: 200,
  });
  const start = Date.now();
  let msgs = await fetchNew();
  while (msgs.length === 0 && wait > 0 && (Date.now() - start) < wait * 1000) {
    await new Promise((res) => setTimeout(res, 1500));
    msgs = await fetchNew();
  }
  return jsonOk({ roomId, messages: msgs });
});

const Body = z.object({ roomId: z.string().min(1), body: z.string().trim().min(1).max(2000) });

export const POST = withErrorHandling(async (req: NextRequest) => {
  assertCsrf();
  const admin = await requireAdminUser();
  const { roomId, body } = Body.parse(await req.json());
  const room = await prisma.chatRoom.findUnique({ where: { id: roomId } });
  if (!room) return jsonError('Room not found.', 404);
  const msg = await prisma.chatMessage.create({ data: { roomId, fromId: admin.id, body } });
  await prisma.chatRoom.update({ where: { id: room.id }, data: { status: 'OPEN' } });
  return jsonOk({ id: msg.id, createdAt: msg.createdAt });
});
