import { EventEmitter } from 'events';

const simEvents = new EventEmitter();
simEvents.setMaxListeners(30);

export { simEvents };
