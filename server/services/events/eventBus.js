'use strict';

/**
 * Event Bus — Kafka Implementation
 * Connects to Kafka via kafkajs. Falls back to EventEmitter if disabled.
 */

const { EventEmitter } = require('events');
const { Kafka } = require('kafkajs');

class EventBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(100);
    this.useKafka = process.env.NODE_ENV === 'production' || process.env.KAFKA_BROKERS;
    this.eventLog = [];
    this.dlq = [];
    this.metrics = {};

    if (this.useKafka) {
      const brokers = (process.env.KAFKA_BROKERS || 'localhost:9092').split(',');
      this.kafka = new Kafka({
        clientId: 'skyplatform-api',
        brokers,
        retry: { initialRetryTime: 100, retries: 8 }
      });
      this.producer = this.kafka.producer();
      this.consumers = new Map(); // topic -> consumer
      
      this.producer.connect().then(() => console.log('[Kafka] Producer Connected')).catch(console.error);
    } else {
      console.log('[EventBus] Using In-Memory Fallback bus');
    }
  }

  async publish(topic, type, payload) {
    const event = {
      eventId: require('uuid').v4(),
      topic,
      type,
      payload,
      timestamp: new Date().toISOString(),
      retries: 0,
    };

    this.metrics[topic] = (this.metrics[topic] || 0) + 1;

    if (this.useKafka) {
      try {
        await this.producer.send({
          topic,
          messages: [
            { key: type, value: JSON.stringify(event) }
          ]
        });
        if (process.env.NODE_ENV !== 'test') console.log(`[Kafka] 📤 ${topic} → ${type}`);
      } catch (err) {
        console.error(`[Kafka] Publish error on ${topic}:`, err.message);
        this.emit(topic, event); // Fallback locally
      }
    } else {
      this.eventLog.push(event);
      if (this.eventLog.length > 10000) this.eventLog.shift();
      this.emit(topic, event);
      this.emit(`${topic}:${type}`, event);
      if (process.env.NODE_ENV !== 'test') console.log(`[EventBus] 📤 ${topic} → ${type}`);
    }

    return event;
  }

  async subscribe(topic, handler, options = {}) {
    const channel = options.type ? `${topic}:${options.type}` : topic;
    
    if (this.useKafka) {
      if (!this.consumers.has(topic)) {
        const consumer = this.kafka.consumer({ groupId: `skyplatform-${topic}-group` });
        await consumer.connect();
        await consumer.subscribe({ topic, fromBeginning: false });
        this.consumers.set(topic, consumer);
        
        await consumer.run({
          eachMessage: async ({ topic: t, partition, message }) => {
            const eventPayload = JSON.parse(message.value.toString());
            // Map Kafka's event type handling
            this.emit(t, eventPayload);
            this.emit(`${t}:${eventPayload.type}`, eventPayload);
          },
        });
        console.log(`[Kafka] Consumer Subscribed to ${topic}`);
      }
    }

    // Bind local emitter to process both local and Kafka-forwarded events
    this.on(channel, async (event) => {
      try {
        await handler(event);
      } catch (err) {
        console.error(`[EventBus/Kafka] ❌ Handler error for ${event.type}:`, err.message);
        event.retries++;
        if (event.retries <= 3) {
          setTimeout(() => this.emit(channel, event), event.retries * 1000);
        } else {
          this.dlq.push({ event, error: err.message, failedAt: new Date().toISOString() });
          console.error(`[EventBus] 💀 Event sent to DLQ: ${event.type}`);
        }
      }
    });
  }

  replay(topic, limit = 100) {
    return this.eventLog.filter(e => e.topic === topic).slice(-limit);
  }

  getMetrics() {
    return {
      mode: this.useKafka ? 'Kafka Clustered' : 'In-Memory',
      events: this.metrics,
      dlqSize: this.dlq.length,
    };
  }
}

const eventBus = new EventBus();

const TOPICS = {
  BOOKING:   'booking.events',
  PAYMENT:   'payment.events',
  INVENTORY: 'inventory.events',
  FLIGHT_OPS:'flight.operations',
  USER_BEH:  'user.behavior',
  PRICING:   'pricing.events',
  NOTIFICATION: 'notification.events',
};

const EVENTS = {
  BOOKING_INITIATED: 'booking_initiated',
  BOOKING_CREATED:   'booking_created',
  BOOKING_CONFIRMED: 'booking_confirmed',
  BOOKING_CANCELLED: 'booking_cancelled',
  BOOKING_EXPIRED:   'booking_expired',
  PAYMENT_INITIATED: 'payment_initiated',
  PAYMENT_COMPLETED: 'payment_completed',
  PAYMENT_FAILED:    'payment_failed',
  REFUND_INITIATED:  'refund_initiated',
  SEAT_LOCKED:       'seat_locked',
  SEAT_RELEASED:     'seat_released',
  INVENTORY_LOW:     'inventory_threshold',
  OVERBOOKING_TRIGGER: 'overbooking_trigger',
  FLIGHT_DELAYED:    'flight_delayed',
  FLIGHT_CANCELLED:  'flight_cancelled',
  GATE_CHANGED:      'gate_changed',
  SEARCH_PERFORMED:  'search_performed',
  FLIGHT_VIEWED:     'flight_viewed',
  OFFER_CLICKED:     'offer_clicked',
};

module.exports = { eventBus, TOPICS, EVENTS };
