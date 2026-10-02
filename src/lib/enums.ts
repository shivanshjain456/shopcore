/**
 * SQLite doesn't support native enums in Prisma, so we use `String` columns
 * and enforce allowed values here (also exported as Zod enums for validation).
 */
import { z } from 'zod';

export const UserRole = {
  CUSTOMER: 'CUSTOMER',
  B2B:      'B2B',
  ADMIN:    'ADMIN',
} as const;
export type UserRole = (typeof UserRole)[keyof typeof UserRole];
export const ZUserRole = z.enum(['CUSTOMER', 'B2B', 'ADMIN']);

export const UserStatus = {
  PENDING_OTP:                 'PENDING_OTP',
  PENDING_PHONE_VERIFICATION:  'PENDING_PHONE_VERIFICATION',
  ACTIVE:                      'ACTIVE',
  SUSPENDED:                   'SUSPENDED',
  DELETED:                     'DELETED',
} as const;
export type UserStatus = (typeof UserStatus)[keyof typeof UserStatus];
export const ZUserStatus = z.enum([
  'PENDING_OTP', 'PENDING_PHONE_VERIFICATION', 'ACTIVE', 'SUSPENDED', 'DELETED',
]);

export const OrderStatus = {
  PENDING_PAYMENT_REVIEW: 'PENDING_PAYMENT_REVIEW',
  PAYMENT_VERIFIED:       'PAYMENT_VERIFIED',
  PAYMENT_REJECTED:       'PAYMENT_REJECTED',
  PROCESSING:             'PROCESSING',
  PACKED:                 'PACKED',
  SHIPPED:                'SHIPPED',
  OUT_FOR_DELIVERY:       'OUT_FOR_DELIVERY',
  DELIVERED:              'DELIVERED',
  CANCELLED:              'CANCELLED',
  RETURNED:               'RETURNED',
  REFUNDED:               'REFUNDED',
} as const;
export type OrderStatus = (typeof OrderStatus)[keyof typeof OrderStatus];
export const ZOrderStatus = z.enum([
  'PENDING_PAYMENT_REVIEW', 'PAYMENT_VERIFIED', 'PAYMENT_REJECTED',
  'PROCESSING', 'PACKED', 'SHIPPED', 'OUT_FOR_DELIVERY',
  'DELIVERED', 'CANCELLED', 'RETURNED', 'REFUNDED',
]);

export const PaymentStatus = {
  AWAITING_VERIFICATION: 'AWAITING_VERIFICATION',
  VERIFIED:              'VERIFIED',
  REJECTED:              'REJECTED',
  REFUNDED:              'REFUNDED',
} as const;
export type PaymentStatus = (typeof PaymentStatus)[keyof typeof PaymentStatus];
export const ZPaymentStatus = z.enum(['AWAITING_VERIFICATION', 'VERIFIED', 'REJECTED', 'REFUNDED']);

export const ReturnStatus = {
  REQUESTED:        'REQUESTED',
  APPROVED:         'APPROVED',
  REJECTED:         'REJECTED',
  ITEM_RECEIVED:    'ITEM_RECEIVED',
  REFUND_ISSUED:    'REFUND_ISSUED',
  EXCHANGE_SHIPPED: 'EXCHANGE_SHIPPED',
  CLOSED:           'CLOSED',
} as const;
export type ReturnStatus = (typeof ReturnStatus)[keyof typeof ReturnStatus];
export const ZReturnStatus = z.enum([
  'REQUESTED', 'APPROVED', 'REJECTED', 'ITEM_RECEIVED',
  'REFUND_ISSUED', 'EXCHANGE_SHIPPED', 'CLOSED',
]);

export const ReturnType = {
  RETURN:      'RETURN',
  EXCHANGE:    'EXCHANGE',
  REFUND_ONLY: 'REFUND_ONLY',
} as const;
export type ReturnType = (typeof ReturnType)[keyof typeof ReturnType];
export const ZReturnType = z.enum(['RETURN', 'EXCHANGE', 'REFUND_ONLY']);

export const DiscountType = {
  PERCENT:       'PERCENT',
  FLAT:          'FLAT',
  FREE_SHIPPING: 'FREE_SHIPPING',
} as const;
export type DiscountType = (typeof DiscountType)[keyof typeof DiscountType];
export const ZDiscountType = z.enum(['PERCENT', 'FLAT', 'FREE_SHIPPING']);

export const TicketStatus = {
  OPEN:               'OPEN',
  AWAITING_CUSTOMER:  'AWAITING_CUSTOMER',
  AWAITING_AGENT:     'AWAITING_AGENT',
  RESOLVED:           'RESOLVED',
  CLOSED:             'CLOSED',
} as const;
export type TicketStatus = (typeof TicketStatus)[keyof typeof TicketStatus];
export const ZTicketStatus = z.enum(['OPEN', 'AWAITING_CUSTOMER', 'AWAITING_AGENT', 'RESOLVED', 'CLOSED']);

// Allowed Indian states (for signup state field validation)
export const INDIAN_STATES = [
  'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chhattisgarh', 'Goa',
  'Gujarat', 'Haryana', 'Himachal Pradesh', 'Jharkhand', 'Karnataka', 'Kerala',
  'Madhya Pradesh', 'Maharashtra', 'Manipur', 'Meghalaya', 'Mizoram', 'Nagaland',
  'Odisha', 'Punjab', 'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana',
  'Tripura', 'Uttar Pradesh', 'Uttarakhand', 'West Bengal',
  // UTs
  'Andaman and Nicobar Islands', 'Chandigarh', 'Dadra and Nagar Haveli and Daman and Diu',
  'Delhi', 'Jammu and Kashmir', 'Ladakh', 'Lakshadweep', 'Puducherry',
] as const;
export const ZIndianState = z.enum(INDIAN_STATES);
