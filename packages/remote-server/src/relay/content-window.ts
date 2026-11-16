import {
  CONTENT_WINDOW_CHUNKS,
  RemoteProtocolError,
  type RelayFrame,
} from '@gian/remote-protocol';

interface InFlightContent {
  sequence: number;
  routeId: string;
}

/** Content frames a sender has in flight, per route. A Host socket carries
 *  every device route and each device acks only its own, so each route of a
 *  connection gets its own window. A device connection has one route. */
export class ContentFlowWindow {
  readonly #inFlight = new Map<string, InFlightContent[]>();
  readonly #contentFrameIds = new Set<string>();

  accept(connectionId: string, frame: RelayFrame): void {
    if (frame.frame_class !== 'content') {
      throw new RemoteProtocolError('INVALID_FRAME', 'only content frames use the content window.');
    }
    const current = this.#inFlight.get(connectionId) ?? [];
    if (this.inFlight(connectionId, frame.route_id) >= CONTENT_WINDOW_CHUNKS) {
      throw new RemoteProtocolError('RATE_LIMITED', 'content window is full.');
    }
    current.push({ sequence: frame.transport_sequence, routeId: frame.route_id });
    this.#inFlight.set(connectionId, current);
    this.#contentFrameIds.add(frame.frame_id);
  }

  ack(connectionId: string, count = 1): void {
    const current = this.#inFlight.get(connectionId) ?? [];
    this.#inFlight.set(connectionId, current.slice(Math.max(0, count)));
  }

  releaseThrough(connectionId: string, routeId: string, transportAck: number): number {
    const current = this.#inFlight.get(connectionId) ?? [];
    const kept = current.filter((item) => !(item.routeId === routeId && item.sequence <= transportAck));
    this.#inFlight.set(connectionId, kept);
    return current.length - kept.length;
  }

  drop(connectionId: string): void {
    this.#inFlight.delete(connectionId);
  }

  /** A new crypto session restarts the route's sequences, so content of the
   *  old session would otherwise wait for acks that never come. */
  dropRoute(connectionId: string, routeId: string): void {
    const current = this.#inFlight.get(connectionId);
    if (current) this.#inFlight.set(connectionId, current.filter((item) => item.routeId !== routeId));
  }

  /** In flight on the whole connection, or on one of its routes. */
  inFlight(connectionId: string, routeId?: string): number {
    const current = this.#inFlight.get(connectionId) ?? [];
    return routeId === undefined ? current.length : current.filter((item) => item.routeId === routeId).length;
  }

  sawContentFrame(frameId: string): boolean {
    return this.#contentFrameIds.has(frameId);
  }
}
