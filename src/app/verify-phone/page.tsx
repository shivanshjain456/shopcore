import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth/session';
import { AuthShell } from '@/components/AuthForm';
import { UserStatus } from '@/lib/enums';
import VerifyPhoneClient from './VerifyPhoneClient';

export const dynamic = 'force-dynamic';

/**
 * /verify-phone — second step of the new two-factor onboarding
 * (email OTP → phone OTP → ACTIVE).
 *
 * Server component:
 *   - Requires a session.
 *   - If user is ACTIVE + already phone-verified → redirect to /account.
 *   - If user is anything other than PENDING_PHONE_VERIFICATION / ACTIVE
 *     → redirect to /login.
 *   - Otherwise render the client form pre-populated with the user's phone.
 *
 * Stands outside the storefront layout group so the header / cart /
 * footer chrome is suppressed (matches `/verify` for email OTP).
 */
export default async function VerifyPhonePage({
  searchParams,
}: {
  searchParams: { from?: string };
}) {
  const user = await getCurrentUser();
  if (!user) redirect('/login?next=/verify-phone');

  if (user.status === UserStatus.ACTIVE && user.phoneVerified) {
    // Nothing to do.
    redirect('/account');
  }
  if (user.status !== UserStatus.PENDING_PHONE_VERIFICATION
   && user.status !== UserStatus.ACTIVE) {
    redirect('/login');
  }

  const fromRegistration = searchParams?.from === 'registration';

  return (
    <AuthShell
      title="Verify your phone number"
      subtitle={
        fromRegistration
          ? 'One more step — verify your phone to finish setting up your account.'
          : 'Verify your phone number to secure your account.'
      }
    >
      <VerifyPhoneClient
        phone={user.phone}
        fromRegistration={fromRegistration}
      />
    </AuthShell>
  );
}
