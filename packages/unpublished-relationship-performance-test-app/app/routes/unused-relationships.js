import Route from '@ember/routing/route';

/**
 * Measures the performance characteristics of pushing a large payload
 * with tons of relationship data that will not be accessed.
 */
export default class UnusedRelationshipsRoute extends Route {
  async model() {
    performance.mark('start-data-generation');

    const payload = await fetch('./fixtures/unused-relationships.json').then((r) => r.json());

    performance.mark('start-push-payload');
    this.store.push(payload);
    performance.mark('end-push-payload');
  }
}
