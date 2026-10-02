'use client';

export default function InvoiceFooter({ orderId }: { orderId: string }) {
  return (
    <div className="no-print mt-6 flex justify-center gap-2">
      <button onClick={() => window.print()} className="rounded-md bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700">
        Print / Save as PDF
      </button>
      <a href={`/orders/${orderId}`} className="rounded-md border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50">
        ← Back to order
      </a>
    </div>
  );
}
