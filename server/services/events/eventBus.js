'use strict';

/**
 * Event Bus — Kafka (production) / EventEmitter (development)
 *
 * Production hardening:
 *  - KAFKA_BROKERS is required when NODE_ENV=production; process exits if missing.
 *  - Dead-Letter Queue entries are written to `audit_log` (crash-safe persistence).
 *  - Consumer groups are named per topic for independent offset tracking.
 *  - In-memory eventLog is retained for dev replay/introspection only.
 */

const { EventEmitter } = require('events');
const { Kafka } = require('kafkajs');
const { v4: uuidv4 } = require('uuid');

const PROD = process.env.NODE_ENV === 'production';

if (PROD && !process.env.KAFKA_BROKERS) {
  console.error('[EventBus] ❌ KAFKA_BROKERS is required in production.');
  console.error('   Set KAFKA_BROKERS=broker1:9092,broker2:9092 in your environment.');
  process.exit(1);
}

class EventBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(100);

    this.useKafka = Boolean(process.env.KAFKA_BROKERS);
    this.eventLog = [];   // dev-only in-memory replay buffer
    this.dlqSize  = 0;    // count of events sent to DLQ (persisted in audit_log)
    this.metrics  = {};

    if (this.useKafka) {
      const brokers = process.env.KAFKA_BROKERS.split(',');
      this.kafka = new Kafka({
        clientId: 'skyplatform-api',
        brokers,
        retry: { initialRetryTime: 100, retries: 8 },
      });
      this.producer  = this.kafka.producer();
      this.consumers = new Map(); // topic → consumer

      this.producer.connect()
        .then(() => console.log('[Kafka] ✅ Producer connected'))
        .catch((err) => {
          console.error('[Kafka] ❌ Producer connection failed:', err.message);
          if (PROD) process.exit(1);
        });
    } else {
      console.log('[EventBus] ⚠️  Using in-memory bus (development only — not suitable for multi-replica)');
    }
  }

  // ── Publish ────────────────────────────────────────────────────────────────────
  async publish(topic, type, payload) {
    const event = {
      eventId:   uuidv4(),
      topic,
      type,
      payload,
      timestamp: new Date().toISOString(),
      retries:   0,
    };

    this.metrics[topic] = (this.metrics[topic] || 0) + 1;

    if (this.useKafka) {
      try {
        await this.producer.send({
          topic,
          messages: [{ key: type, value: JSON.stringify(event) }],
        });
        if (!PROD) console.log(`[Kafka] 📤 ${topic} → ${type}`);
      } catch (err) {
        console.error(`[Kafka] ❌ Publish failed on ${topic}:`, err.message);
        // Best-effort local delivery so in-process handlers still fire
        this._emitLocally(topic, type, event);
      }
    } else {
      this.eventLog.push(event);
      if (this.eventLog.length > 10000) this.eventLog.shift();
      this._emitLocally(topic, type, event);
      if (!PROD) console.log(`[EventBus] 📤 ${topic} → ${type}`);
    }

    return event;
  }

  _emitLocally(topic, type, event) {
    this.emit(topic, event);
    this.emit(`${topic}:${type}`, event);
  }

  // ── Subscribe ──────────────────────────────────────────────────────────────────
  async subscribe(topic, handler, options = {}) {
    const channel = options.type ? `${topic}:${options.type}` : topic;

    if (this.useKafka && !this.consumers.has(topic)) {
      // One consumer group per topic so each topic's offset is tracked independently
      const groupId  = `skyplatform-${topic.replace(/\./g, '-')}-group`;
      const consumer = this.kafka.consumer({ groupId });

      await consumer.connect();
      await consumer.subscribe({ topic, fromBeginning: false });
      this.consumers.set(topic, consumer);

      await consumer.run({
        eachMessage: async ({ topic: t, message }) => {
          try {
            const parsed = JSON.parse(message.value.toString());
            this._emitLocally(t, parsed.type, parsed);
          } catch (err) {
            console.error(`[Kafka] ❌ Failed to parse message on ${t}:`, err.message);
          }
        },
      });
      console.log(`[Kafka] ✅ Consumer subscribed to ${topic} (group: ${groupId})`);
    }

    // Local EventEmitter bridge — handles both Kafka-forwarded and in-memory events
    this.on(channel, async (event) => {
      try {
        await handler(event);
      } catch (err) {
        console.error(`[EventBus] ❌ Handler error for ${event.type}:`, err.message);
        event.retries = (event.retries || 0) + 1;

        if (event.retries <= 3) {
          // Exponential backoff retry
          setTimeout(() => this._emitLocally(topic, event.type, event), event.retries * 1000);
        } else {
          await this._sendToDLQ(event, err.message);
        }
      }
    });
  }

  // ── Dead-Letter Queue (DB-persisted) ──────────────────────────────────────────
  async _sendToDLQ(event, errorMessage) {
    this.dlqSize++;
    console.error(`[EventBus] 💀 DLQ: ${event.type} (eventId: ${event.eventId})`);

    try {
      // Lazy-require db to avoid circular dependency at module load time
      const db = require('../../db');
      await db.query(
        `INSERT INTO audit_log (log_id, action, resource_type, resource_id, new_value)
         VALUES ($1, 'DLQ_EVENT', $2, $3, $4)`,
        [
          uuidv4(),
          event.topic,
          event.eventId,
          JSON.stringify({ event, error: errorMessage, failedAt: new Date().toISOString() }),
        ]
      );
    } catch (dbErr) {
      console.error('[EventBus] ❌ DLQ write to DB failed:', dbErr.message);
    }
  }

  // ── Introspection ──────────────────────────────────────────────────────────────
  replay(topic, limit = 100) {
    return this.eventLog.filter(e => e.topic === topic).slice(-limit);
  }

  getMetrics() {
    return {
      mode:    this.useKafka ? 'Kafka' : 'In-Memory (dev)',
      events:  this.metrics,
      dlqSize: this.dlqSize,
    };
  }
}

const eventBus = new EventBus();

const TOPICS = {
  BOOKING:      'booking.events',
  PAYMENT:      'payment.events',
  INVENTORY:    'inventory.events',
  FLIGHT_OPS:   'flight.operations',
  USER_BEH:     'user.behavior',
  PRICING:      'pricing.events',
  NOTIFICATION: 'notification.events',
};

const EVENTS = {
  BOOKING_INITIATED:   'booking_initiated',
  BOOKING_CREATED:     'booking_created',
  BOOKING_CONFIRMED:   'booking_confirmed',
  BOOKING_CANCELLED:   'booking_cancelled',
  BOOKING_EXPIRED:     'booking_expired',
  PAYMENT_INITIATED:   'payment_initiated',
  PAYMENT_COMPLETED:   'payment_completed',
  PAYMENT_FAILED:      'payment_failed',
  REFUND_INITIATED:    'refund_initiated',
  SEAT_LOCKED:         'seat_locked',
  SEAT_RELEASED:       'seat_released',
  INVENTORY_LOW:       'inventory_threshold',
  OVERBOOKING_TRIGGER: 'overbooking_trigger',
  FLIGHT_DELAYED:      'flight_delayed',
  FLIGHT_CANCELLED:    'flight_cancelled',
  GATE_CHANGED:        'gate_changed',
  SEARCH_PERFORMED:    'search_performed',
  FLIGHT_VIEWED:       'flight_viewed',
  OFFER_CLICKED:       'offer_clicked',
};

module.exports = { eventBus, TOPICS, EVENTS };
