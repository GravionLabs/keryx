import { EventEmitter } from 'node:events';
import type { BusEvent } from './events/schema.js';

const CHANNEL = 'event';

/** In-process fan-out of stored events to the open `GET /events/stream` connections. */
export class BusEvents extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(0);
  }

  /** Broadcast a stored event to every stream subscriber. */
  publishEvent(event: BusEvent): void {
    this.emit(CHANNEL, event);
  }

  onEvent(listener: (event: BusEvent) => void): () => void {
    this.on(CHANNEL, listener);
    return () => this.off(CHANNEL, listener);
  }

  eventListenerCount(): number {
    return this.listenerCount(CHANNEL);
  }
}
