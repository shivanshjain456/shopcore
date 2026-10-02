'use client';

import { FormEvent, useEffect, useState } from 'react';
import { api } from '@/lib/client/api';
import { INDIAN_STATES } from '@/lib/enums';
import { useDialog } from '@/components/dialog/DialogProvider';
import PincodeField from '@/components/forms/PincodeField';
import PhoneField   from '@/components/forms/PhoneField';
import { formatPhone } from '@/lib/utils/phone';

interface Address {
  id: string; label: string | null; fullName: string; phone: string;
  addressLine1: string; addressLine2: string; city: string; state: string; pinCode: string; country: string;
  isDefault: boolean;
}

export default function AddressesPage() {
  const [list, setList] = useState<Address[] | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const dialog = useDialog();

  // ── Feature #13: controlled state for pincode-autofill-aware fields. ─────
  // We previously read these via FormData; now they're controlled because
  // PincodeField writes into them. The non-pincode fields stay FormData so
  // the diff is minimal.
  const [city, setCity]       = useState('');
  const [state, setState]     = useState('');
  const [pinCode, setPinCode] = useState('');
  // Item 9 — phone is now controlled (PhoneField composes E.164 for us).
  const [phone, setPhone]     = useState('');
  function resetAddressForm() {
    setCity(''); setState(''); setPinCode(''); setPhone(''); setErr(null);
  }

  const load = async () => {
    const r = await api<{ addresses: Address[] }>('/api/addresses');
    if (r.status === 401) { window.location.href = '/login?next=/account/addresses'; return; }
    setList(r.data?.addresses ?? []);
  };
  useEffect(() => { void load(); }, []);

  async function add(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErr(null); setBusy(true);
    const f = new FormData(e.currentTarget);
    const r = await api('/api/addresses', { method: 'POST', body: {
      label: String(f.get('label') ?? ''), fullName: String(f.get('fullName') ?? ''),
      // Item 9 — phone is now controlled (PhoneField already composes E.164).
      phone,
      addressLine1: String(f.get('addressLine1') ?? ''), addressLine2: String(f.get('addressLine2') ?? ''),
      // pincode + city + state are now controlled (Feature #13 autofill).
      city, state, pinCode, country: 'India',
    }});
    setBusy(false);
    if (!r.ok) { setErr(r.error ?? 'Could not save.'); return; }
    setShowForm(false); resetAddressForm(); await load();
  }

  async function setDefault(id: string) {
    await api(`/api/addresses/${id}`, { method: 'PATCH', body: { isDefault: true } });
    await load();
  }
  async function del(id: string) {
    const ok = await dialog.confirm({
      title: 'Delete address?',
      message: 'This will remove the address from your account. It cannot be undone.',
      intent: 'destructive', confirmLabel: 'Delete',
    });
    if (!ok) return;
    const r = await api(`/api/addresses/${id}`, { method: 'DELETE' });
    if (!r.ok) { await dialog.alert({ title: 'Could not delete', message: r.error ?? 'Please try again.' }); return; }
    await load();
  }

  return (
    <>
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-slate-900">Addresses</h1>
        <button onClick={() => setShowForm((s) => !s)} className="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-brand-700">
          {showForm ? 'Close' : '+ Add address'}
        </button>
      </div>

      {showForm && (
        <form onSubmit={add} className="mt-4 grid grid-cols-1 gap-3 rounded-xl border border-slate-200 bg-white p-4 sm:grid-cols-2">
          {err && <p className="text-sm text-red-700 sm:col-span-2">{err}</p>}
          <input name="label" placeholder="Label (Home / Office)" className="rounded-md border border-slate-300 px-3 py-2 text-sm sm:col-span-2" />
          <input name="fullName" required placeholder="Full name" className="rounded-md border border-slate-300 px-3 py-2 text-sm" />
          {/* Item 9 — locked +91 prefix, 10-digit input. */}
          <div>
            <PhoneField
              label="Phone"
              value={phone}
              onChange={setPhone}
              required
            />
          </div>
          <input name="addressLine1" required placeholder="Address line 1" className="rounded-md border border-slate-300 px-3 py-2 text-sm sm:col-span-2" />
          <input name="addressLine2" required placeholder="Address line 2" className="rounded-md border border-slate-300 px-3 py-2 text-sm sm:col-span-2" />
          <input
            value={city}
            onChange={(e) => setCity(e.target.value)}
            required placeholder="City"
            data-testid="addr-city"
            className="rounded-md border border-slate-300 px-3 py-2 text-sm"
          />
          <select
            value={state}
            onChange={(e) => setState(e.target.value)}
            required
            data-testid="addr-state"
            className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
          >
            <option value="" disabled>State</option>
            {INDIAN_STATES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <div className="sm:col-span-2">
            <PincodeField
              value={pinCode}
              onChange={setPinCode}
              onAutofill={(a) => {
                if (!city.trim() && a.city) setCity(a.city);
                if (!state && a.state)      setState(a.state);
              }}
              data-testid="addr-pincode"
            />
          </div>
          <button disabled={busy} type="submit" className="rounded-md bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 sm:col-span-2">
            {busy ? 'Saving…' : 'Save'}
          </button>
        </form>
      )}

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {list?.map((a) => (
          <div key={a.id} className={`rounded-xl border bg-white p-4 ${a.isDefault ? 'border-brand-300' : 'border-slate-200'}`}>
            <div className="flex items-start justify-between">
              <p className="font-semibold">
                {a.fullName} {a.label && <span className="ml-2 rounded bg-slate-100 px-1.5 text-xs font-medium text-slate-600">{a.label}</span>}
                {a.isDefault && <span className="ml-2 rounded bg-brand-100 px-1.5 text-xs font-semibold text-brand-800">Default</span>}
              </p>
            </div>
            <p className="text-sm text-slate-700">{a.addressLine1}, {a.addressLine2}</p>
            <p className="text-sm text-slate-700">{a.city}, {a.state} — {a.pinCode}, {a.country}</p>
            <p className="text-sm text-slate-500">{formatPhone(a.phone)}</p>
            <div className="mt-3 flex gap-2">
              {!a.isDefault && <button onClick={() => setDefault(a.id)} className="rounded-md border border-slate-300 px-2.5 py-1 text-xs hover:bg-slate-50">Make default</button>}
              <button onClick={() => del(a.id)} className="rounded-md border border-red-300 px-2.5 py-1 text-xs text-red-700 hover:bg-red-50">Delete</button>
            </div>
          </div>
        ))}
        {list && list.length === 0 && <p className="rounded-lg border border-dashed border-slate-300 p-6 text-sm text-slate-500 sm:col-span-2">No addresses yet.</p>}
      </div>
    </>
  );
}
