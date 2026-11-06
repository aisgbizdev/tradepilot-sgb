import { EventEmitter } from "node:events";

export interface NotificationEvent {
  userId: number;
  notification: {
    id?: number;
    title: string;
    message: string;
    type?: string | null;
    // Store-readiness (P2-B2): carried on the SSE event too so a client
    // can render/act on a fresh notification without a full refetch.
    category?: string | null;
    actionType?: string | null;
    actionId?: string | null;
    createdAt?: string;
  };
}

class NotificationsEmitter extends EventEmitter {
  emitForUser(userId: number, notification: NotificationEvent["notification"]) {
    this.emit(`user:${userId}`, { userId, notification });
  }

  subscribeForUser(userId: number, listener: (ev: NotificationEvent) => void) {
    const channel = `user:${userId}`;
    this.on(channel, listener);
    return () => this.off(channel, listener);
  }
}

export const notificationsEmitter = new NotificationsEmitter();

notificationsEmitter.setMaxListeners(0);
