/**
 * Free, deterministic AI helpers — no external API calls, no cost.
 *
 * suggestTags(text):
 *   - Tokenises name + shortDesc + description.
 *   - Removes stopwords + product-noise words.
 *   - Returns top 8 ranked terms by TF, plus a tech-vocabulary boost (intel, ryzen,
 *     ssd, ram, hdd, gst, fhd, etc.).
 *
 * Good enough to seed the `aiTags` column without a paid LLM. Admin can edit.
 */
const STOP = new Set([
  'the','a','an','and','or','of','in','on','for','with','to','from','by','at',
  'is','are','was','were','be','been','being','as','it','this','that','these','those',
  'product','item','feature','model','new','best','top','rs','inr','india','will','have','has','your','our','any','all',
]);
const TECH = new Set([
  'intel','amd','ryzen','core','i3','i5','i7','i9','m1','m2','m3',
  'ssd','hdd','nvme','ram','ddr4','ddr5','gpu','rtx','gtx',
  'fhd','qhd','uhd','ips','oled','retina','144hz','60hz','120hz',
  'usb','typec','hdmi','vga','dp','rgb','wifi6','bluetooth','tws','anc',
  'gaming','business','student','office','home','portable','thin','light',
  'silver','space','grey','black','white','blue',
  'gst','hsn',
]);

export function suggestTags(text: string, max = 8): string[] {
  const lower = text.toLowerCase();
  const tokens = lower.match(/[a-z0-9]{2,}/g) ?? [];
  const counts = new Map<string, number>();
  for (const t of tokens) {
    if (STOP.has(t)) continue;
    counts.set(t, (counts.get(t) ?? 0) + 1 + (TECH.has(t) ? 5 : 0));
  }
  // Take by score, prefer longer/tech tokens to break ties
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || (TECH.has(b[0]) ? 1 : 0) - (TECH.has(a[0]) ? 1 : 0) || b[0].length - a[0].length)
    .slice(0, max)
    .map(([t]) => t);
}
