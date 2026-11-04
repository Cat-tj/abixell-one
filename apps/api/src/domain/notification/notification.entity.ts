/**
 * Domain types for the Notification Engine (Checkpoint 0E), per
 * 06-Notification-Document-Audit-Foundation.md. Template content is
 * Tenant Configuration (same pattern as doc 05: "isi pesan, bahasa, dan
 * channel default dapat berbeda per Tenant tanpa ubah kode"), resolved at
 * send time against a Domain Event's payload via `{{field}}`
 * interpolation — deliberately minimal, same anti-overengineering
 * posture as 0D's ConditionExpression (a full templating engine is not
 * needed to prove the concept end-to-end).
 */

export type NotificationChannel = "email" | "push" | "whatsapp" | "sms" | "in_app";
export type NotificationStatus = "sent" | "failed" | "skipped";

export interface NotificationTemplate {
  id: string;
  tenantId: string;
  eventType: string;
  channel: NotificationChannel;
  subjectTemplate: string | null;
  bodyTemplate: string;
  isActive: boolean;
  createdAt: Date;
}

export interface Notification {
  id: string;
  tenantId: string;
  domainEventId: string | null;
  eventType: string;
  /** The business object the event was about (from domain_events) — lets the
   * UI link the notification to the task it refers to. Null for legacy rows
   * or events without an entity. */
  entityType?: string | null;
  entityId?: string | null;
  channel: NotificationChannel;
  recipientUserId: string | null;
  subject: string | null;
  body: string;
  status: NotificationStatus;
  errorMessage: string | null;
  sentAt: Date | null;
  readAt: Date | null;
  createdAt: Date;
}

export interface NotificationRepository {
  createTemplate(input: {
    tenantId: string;
    eventType: string;
    channel: NotificationChannel;
    subjectTemplate: string | null;
    bodyTemplate: string;
  }): Promise<NotificationTemplate>;

  listTemplates(tenantId: string): Promise<NotificationTemplate[]>;

  findTemplate(
    tenantId: string,
    eventType: string,
    channel: NotificationChannel,
  ): Promise<NotificationTemplate | null>;

  createNotification(input: {
    tenantId: string;
    domainEventId: string | null;
    eventType: string;
    channel: NotificationChannel;
    recipientUserId: string | null;
    subject: string | null;
    body: string;
    status: NotificationStatus;
    errorMessage: string | null;
    sentAt: Date | null;
  }): Promise<Notification>;

  listForRecipient(tenantId: string, recipientUserId: string, limit: number): Promise<Notification[]>;
  listForTenant(tenantId: string, limit: number): Promise<Notification[]>;

  markRead(id: string, recipientUserId: string): Promise<Notification | null>;
  findById(id: string): Promise<Notification | null>;
}
