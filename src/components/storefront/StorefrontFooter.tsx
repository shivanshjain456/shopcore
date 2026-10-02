export default function StorefrontFooter() {
  return (
    <footer className="mt-16 border-t border-slate-200 bg-white">
      <div className="mx-auto grid max-w-7xl gap-8 px-4 py-10 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <p className="text-sm font-bold text-slate-900">ShopCore</p>
          <p className="mt-2 text-sm text-slate-600">
            Laptops, desktops and electronics — built for buyers across India.
          </p>
        </div>
        <div>
          <p className="text-sm font-semibold text-slate-900">Shop</p>
          <ul className="mt-2 space-y-1 text-sm text-slate-600">
            <li><a href="/c/laptops" className="hover:text-brand-700">Laptops</a></li>
            <li><a href="/c/desktops" className="hover:text-brand-700">Desktops</a></li>
            <li><a href="/c/computers" className="hover:text-brand-700">Computers</a></li>
            <li><a href="/c/accessories" className="hover:text-brand-700">Accessories</a></li>
            <li><a href="/c/electronics" className="hover:text-brand-700">Electronics</a></li>
          </ul>
        </div>
        <div>
          <p className="text-sm font-semibold text-slate-900">Account</p>
          <ul className="mt-2 space-y-1 text-sm text-slate-600">
            <li><a href="/account" className="hover:text-brand-700">My orders</a></li>
            <li><a href="/wishlist" className="hover:text-brand-700">Wishlist</a></li>
            <li><a href="/login" className="hover:text-brand-700">Sign in</a></li>
            <li><a href="/signup" className="hover:text-brand-700">Create account</a></li>
            <li><a href="/b2b" className="hover:text-brand-700">B2B portal</a></li>
          </ul>
        </div>
        <div>
          <p className="text-sm font-semibold text-slate-900">Help &amp; Support</p>
          <ul className="mt-2 space-y-1 text-sm text-slate-600">
            {/* Item 13 — public-facing entry points. /support is the
                self-service hub (FAQ + tickets); /contact is the form. */}
            <li><a href="/support" className="hover:text-brand-700">Support center</a></li>
            <li><a href="/contact" className="hover:text-brand-700">Contact us</a></li>
            <li>Ships across India only</li>
            <li>UPI payment via QR (you&apos;ll see at checkout)</li>
            <li>Returns &amp; exchanges per policy</li>
          </ul>
        </div>
      </div>
      <div className="border-t border-slate-100 px-4 py-4 text-center text-xs text-slate-500">
        © {new Date().getFullYear()} ShopCore · All prices in ₹ INR · India only
      </div>
    </footer>
  );
}
