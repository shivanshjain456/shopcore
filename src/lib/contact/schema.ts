/**
 * Contact form Zod schema — Item 13.
 *
 * Shared between the public client component `<ContactForm>` and the
 * server route `POST /api/contact` so the two never drift.
 *
 *   - name:    max 100 chars, trimmed
 *   - email:   valid format, max 254 (RFC 5321 path-length)
 *   - subject: max 120, trimmed
 *   - message: 20 – 2000 chars, trimmed
 *   - website: HONEYPOT — never visible in the UI; non-empty value
 *              flags the submission as bot traffic. The route handler
 *              silently 200s on hits.
 */
import { z } from 'zod';

export const CONTACT_SUBJECT_MAX = 120;
export const CONTACT_MESSAGE_MIN = 20;
export const CONTACT_MESSAGE_MAX = 2000;

export const ContactFormSchema = z.object({
  name:    z.string().trim().min(1, 'Please tell us your name.').max(100, 'Name is too long.'),
  email:   z.string().trim().email('Please enter a valid email address.').max(254),
  subject: z.string().trim().min(1, 'A short subject helps us route your message.').max(CONTACT_SUBJECT_MAX, 'Subject is too long.'),
  message: z.string().trim()
    .min(CONTACT_MESSAGE_MIN, `Please write at least ${CONTACT_MESSAGE_MIN} characters so we can help.`)
    .max(CONTACT_MESSAGE_MAX, `Please keep your message under ${CONTACT_MESSAGE_MAX} characters.`),
  // Honeypot — bots fill every input they see; humans never see this.
  // Optional so legitimate submissions don't need to send it at all.
  website: z.string().max(500).optional(),
}).strict();

export type ContactFormInput = z.infer<typeof ContactFormSchema>;
