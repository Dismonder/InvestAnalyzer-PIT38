import type { PriceAlert, LiveMarketQuote } from '../types';
import { evaluatePriceAlert } from './priceAlertLogic';

export interface AppNotification {
  id: string;
  title: string;
  body: string;
  type: 'ALERT' | 'INFO' | 'SUCCESS' | 'WARNING';
  timestamp: string;
  read: boolean;
}

class PushNotificationService {
  private hasPermission = false;
  private notifications: AppNotification[] = [];
  private listeners: Set<(notifications: AppNotification[]) => void> = new Set();
  private audioCtx: AudioContext | null = null;
  private soundEnabled = true;

  constructor() {
    if (typeof window !== 'undefined') {
      if ('Notification' in window) {
        this.hasPermission = Notification.permission === 'granted';
      }
      try {
        const savedNotifs = localStorage.getItem('pit38_notifications');
        if (savedNotifs) {
          const parsed = JSON.parse(savedNotifs);
          if (Array.isArray(parsed)) {
            this.notifications = parsed.slice(0, 50);
          }
        }
        const savedSound = localStorage.getItem('pit38_sound_enabled');
        if (savedSound !== null) {
          this.soundEnabled = savedSound !== 'false';
        }
      } catch (e) {
        console.warn('Could not load saved notifications:', e);
      }
    }
  }

  public isSoundEnabled(): boolean {
    return this.soundEnabled;
  }

  public setSoundEnabled(enabled: boolean) {
    this.soundEnabled = enabled;
    try {
      localStorage.setItem('pit38_sound_enabled', enabled ? 'true' : 'false');
    } catch {
      // ignore
    }
  }

  public async requestPermission(): Promise<boolean> {
    if (typeof window === 'undefined' || !('Notification' in window)) {
      return false;
    }
    try {
      const permission = await Notification.requestPermission();
      this.hasPermission = permission === 'granted';
      return this.hasPermission;
    } catch {
      return false;
    }
  }

  public getPermissionStatus(): NotificationPermission | 'unsupported' {
    if (typeof window === 'undefined' || !('Notification' in window)) {
      return 'unsupported';
    }
    return Notification.permission;
  }

  public getNotifications(): AppNotification[] {
    return [...this.notifications];
  }

  public subscribe(listener: (notifications: AppNotification[]) => void): () => void {
    this.listeners.add(listener);
    listener(this.getNotifications());
    return () => {
      this.listeners.delete(listener);
    };
  }

  public markAsRead(id: string) {
    this.notifications = this.notifications.map((n) => (n.id === id ? { ...n, read: true } : n));
    this.saveToStorage();
    this.notify();
  }

  public clearAll() {
    this.notifications = [];
    this.saveToStorage();
    this.notify();
  }

  public playChime() {
    if (!this.soundEnabled) return;
    try {
      if (!this.audioCtx) {
        const AudioContextClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        this.audioCtx = new AudioContextClass();
      }
      if (this.audioCtx.state === 'suspended') {
        this.audioCtx.resume();
      }
      const osc = this.audioCtx.createOscillator();
      const gain = this.audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(587.33, this.audioCtx.currentTime); // D5
      osc.frequency.exponentialRampToValueAtTime(880, this.audioCtx.currentTime + 0.15); // A5
      gain.gain.setValueAtTime(0.2, this.audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, this.audioCtx.currentTime + 0.35);
      osc.connect(gain);
      gain.connect(this.audioCtx.destination);
      osc.start();
      osc.stop(this.audioCtx.currentTime + 0.36);
    } catch {
      // Audio not permitted or supported
    }
  }

  public sendPushNotification(title: string, body: string, type: AppNotification['type'] = 'INFO') {
    const item: AppNotification = {
      id: 'notif_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6),
      title,
      body,
      type,
      timestamp: new Date().toISOString(),
      read: false,
    };

    this.notifications = [item, ...this.notifications].slice(0, 50);
    this.saveToStorage();
    this.notify();
    this.playChime();

    // Send native browser notification if granted
    if (typeof window !== 'undefined' && 'Notification' in window && Notification.permission === 'granted') {
      try {
        new Notification(title, {
          body,
          icon: '/favicon.ico',
        });
      } catch {
        // Ignored if blocked in iframe
      }
    }
  }

  public checkPriceAlerts(
    alerts: PriceAlert[],
    quotes: Record<string, LiveMarketQuote>,
    onAlertTriggered: (updatedAlert: PriceAlert) => void
  ) {
    const now = Date.now();
    alerts.forEach((alert) => {
      const { updatedAlert } = evaluatePriceAlert(alert, quotes, now);
      if (!updatedAlert) return;

      this.sendPushNotification(`🔔 Alert Cenowy: ${alert.ticker}`, updatedAlert.message ?? '', 'ALERT');
      onAlertTriggered(updatedAlert);
    });
  }

  private saveToStorage() {
    try {
      localStorage.setItem('pit38_notifications', JSON.stringify(this.notifications.slice(0, 50)));
    } catch {
      // ignore
    }
  }

  private notify() {
    const list = this.getNotifications();
    this.listeners.forEach((l) => l(list));
  }
}

export const pushNotificationService = new PushNotificationService();
