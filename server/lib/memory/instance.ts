import { MemoryService } from './MemoryService';
import { ContextBuilder } from './ContextBuilder';

export const memoryService = new MemoryService();
export const contextBuilder = new ContextBuilder(memoryService);
