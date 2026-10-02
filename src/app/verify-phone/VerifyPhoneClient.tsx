'use client';
import { useRouter } from 'next/navigation';
import { useCallback } from 'react';
import PhoneVerificationForm from '@/components/auth/PhoneVerificationForm';

interface Props {
  phone: string;
  fromRegistration: boolean;
}

/**
 * Thin client wrapper around <PhoneVerificationForm> that handles the
 * post-success redirect. Split out so the page itself can stay a
 * server component (it needs `getCurrentUser`).
 */
export default function VerifyPhoneClient({ phone, fromRegistration }: Props) {
  const router = useRouter();

  const onSuccess = useCallback((accountStatus: string) => {
    if (accountStatus === 'ACTIVE') {
      // After 800ms the API has finished mutating cookies and the user's
      // refreshed JWT will carry the new `status` claim. Using
      // router.replace avoids leaving /verify-phone in the back stack.
      const dest = fromRegistration ? '/' : '/account';
      setTimeout(() => router.replace(dest), 600);
    }
  }, [fromRegistration, router]);

  return <PhoneVerificationForm phone={phone} onSuccess={onSuccess} />;
}
